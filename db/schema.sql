-- Blanket schema
--
-- Data model: a spreadsheet's full content (all tabs, cells, formulas,
-- formatting) is stored as one JSON document per save. spreadsheet_history
-- is append-only; the current state is the row with the highest `sequence`
-- for that spreadsheet_id. "Restore" = copy an old row's `data` forward as
-- a new latest sequence, never mutate or delete old rows.
--
-- User id 0 is a reserved sentinel meaning "anonymous" (no authenticated
-- user). It is a real row in `users` (seeded in seed.sql) so every FK stays
-- enforced -- no column needs NULL-handling anywhere. Real accounts start
-- at id 1 (AUTO_INCREMENT default).

CREATE TABLE users (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  username       VARCHAR(64)  NOT NULL,
  password_hash  VARCHAR(255) NOT NULL,
  display_name   VARCHAR(128) NOT NULL,
  is_admin       BOOLEAN NOT NULL DEFAULT FALSE,
  created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_username (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE spreadsheets (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  owner_user_id  BIGINT UNSIGNED NOT NULL,
  title          VARCHAR(255) NOT NULL,
  -- latest_sequence mirrors MAX(sequence) in spreadsheet_history for this
  -- spreadsheet, kept in sync in the same transaction as each save, so
  -- "load current state" is a single indexed lookup instead of an
  -- aggregate scan.
  latest_sequence INT UNSIGNED NOT NULL DEFAULT 0,
  created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  -- Soft delete: "authenticated users can delete their own spreadsheets"
  -- but "nothing is permanently deleted except by an administrator."
  -- A non-null deleted_at hides it from the owner; only an admin action
  -- issues a real DELETE.
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
  -- value grants access to that specific authenticated user.
  user_id         BIGINT UNSIGNED NOT NULL DEFAULT 0,
  access_level    ENUM('view', 'edit') NOT NULL,
  granted_by      BIGINT UNSIGNED NOT NULL,
  created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_access_spreadsheet_user (spreadsheet_id, user_id),
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
  -- 16 for IPv6); read back with INET6_NTOA()/inet_ntop().
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
