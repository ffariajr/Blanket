-- Blanket schema
--
-- Data model: a spreadsheet's full content (all tabs, cells, formulas,
-- formatting) is stored as one JSON document per save. spreadsheet_history
-- is append-only; the current state is the row with the highest `sequence`
-- for that spreadsheet_id (MAX(sequence) WHERE spreadsheet_id=? is a cheap
-- loose index scan against uq_history_spreadsheet_sequence below -- no
-- denormalized cache needed). "Restore" = copy an old row's `data` forward
-- as a new latest sequence; never mutate or delete old rows.
--
-- Concurrency: for a spreadsheet with an active WebSocket collaboration
-- session, that WS process is the sole writer of its history rows -- it
-- holds the current document in memory, applies incoming edits
-- sequentially, and persists merged snapshots, which is what actually
-- prevents two editors' saves from clobbering each other (a full-document
-- overwrite race, not just a duplicate-sequence race). For saves made with
-- no live WS session (e.g. a lone editor, CSV import), the writer must
-- serialize sequence-number allocation itself, e.g. `SELECT ... FOR UPDATE`
-- on the owning spreadsheets row before computing MAX(sequence)+1.
--
-- User id 0 is a reserved sentinel meaning "anonymous" (no authenticated
-- user). It is a real row in `users` (seeded in 0002_seed_anonymous_user.sql)
-- so every FK stays enforced -- no column needs NULL-handling anywhere.
-- Real accounts start at id 1 (AUTO_INCREMENT default). Application auth
-- must explicitly refuse login as id 0 / username '__anonymous__' (its
-- password_hash is empty, not usable for a real check), and any
-- "list users" admin view must exclude it.
--
-- Users are never hard-deleted, only soft-deleted (see deleted_at below).
-- History rows permanently attribute a spreadsheet_id + saved_by pair for
-- as long as that history exists, and history is itself never purged, so a
-- user who has ever saved anything can never be safely hard-deleted without
-- destroying the audit trail the whole history feature exists to provide.

CREATE TABLE users (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  username       VARCHAR(64)  NOT NULL,
  password_hash  VARCHAR(255) NOT NULL,
  display_name   VARCHAR(128) NOT NULL,
  is_admin       BOOLEAN NOT NULL DEFAULT FALSE,
  created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- Deactivates the account (blocks login, hides from pickers) without
  -- breaking FK integrity on historical attribution. No hard delete path.
  deleted_at     TIMESTAMP NULL DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_username (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE spreadsheets (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  owner_user_id  BIGINT UNSIGNED NOT NULL,
  title          VARCHAR(255) NOT NULL,
  created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  -- Soft delete: "authenticated users can delete their own spreadsheets"
  -- but "nothing is permanently deleted except by an administrator."
  -- A non-null deleted_at hides it from the owner; only an admin action
  -- issues a real DELETE (which CASCADEs to spreadsheet_access and
  -- spreadsheet_history via their FKs below).
  deleted_at     TIMESTAMP NULL DEFAULT NULL,
  PRIMARY KEY (id),
  KEY idx_spreadsheets_owner (owner_user_id),
  CONSTRAINT fk_spreadsheets_owner
    FOREIGN KEY (owner_user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE spreadsheet_access (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  spreadsheet_id  BIGINT UNSIGNED NOT NULL,
  -- 0 = anonymous access policy for this spreadsheet (at most one such
  -- row per spreadsheet, enforced by the unique key below). Any other
  -- value grants access to that specific authenticated user. The owner
  -- never gets a row here -- ownership (full access) is tracked solely via
  -- spreadsheets.owner_user_id; application code must not also insert an
  -- access row for the owner.
  user_id         BIGINT UNSIGNED NOT NULL DEFAULT 0,
  access_level    ENUM('view', 'edit') NOT NULL,
  granted_by      BIGINT UNSIGNED NOT NULL,
  created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_access_spreadsheet_user (spreadsheet_id, user_id),
  -- Supports "which spreadsheets can user X access" without a full scan.
  KEY idx_access_user (user_id),
  CONSTRAINT fk_access_spreadsheet
    FOREIGN KEY (spreadsheet_id) REFERENCES spreadsheets(id) ON DELETE CASCADE,
  CONSTRAINT fk_access_user
    FOREIGN KEY (user_id) REFERENCES users(id),
  CONSTRAINT fk_access_granted_by
    FOREIGN KEY (granted_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE spreadsheet_history (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  spreadsheet_id  BIGINT UNSIGNED NOT NULL,
  sequence        INT UNSIGNED NOT NULL,
  data            JSON NOT NULL,
  -- 0 = saved by an anonymous editor (only possible if the spreadsheet's
  -- anonymous access row grants 'edit').
  saved_by        BIGINT UNSIGNED NOT NULL DEFAULT 0,
  -- Source IP of the save request, always captured regardless of auth
  -- state. Stored packed via INET6_ATON()/inet_pton() (4 bytes for IPv4,
  -- 16 for IPv6); read back with INET6_NTOA()/inet_ntop(). The app sits
  -- behind Apache as a reverse proxy (see MACHINE.md) -- this MUST be
  -- resolved from X-Forwarded-For (or a trusted proxy header), not the
  -- socket peer address, or every row will just say 127.0.0.1.
  saved_by_ip     VARBINARY(16) NOT NULL,
  -- Self-reported display name shown in the history view. For
  -- authenticated users the app must set this from users.display_name at
  -- save time (never trust a client-supplied name when saved_by <> 0).
  -- For anonymous users (saved_by = 0) this is whatever name the client
  -- sent from its cookie -- unverified and spoofable by a hostile client,
  -- accurate for a non-hostile one; it's attribution, not an access
  -- control.
  saved_by_name   VARCHAR(128) NOT NULL DEFAULT 'Anonymous',
  created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_history_spreadsheet_sequence (spreadsheet_id, sequence),
  CONSTRAINT fk_history_spreadsheet
    FOREIGN KEY (spreadsheet_id) REFERENCES spreadsheets(id) ON DELETE CASCADE,
  CONSTRAINT fk_history_saved_by
    FOREIGN KEY (saved_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
