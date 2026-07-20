-- users: `enabled` lets an admin suspend login without touching
-- deleted_at's soft-delete/archive semantics -- the two are independent.
-- `email` for contact / future password-reset use, unique like username.
--
-- spreadsheets: owner_user_id -> owner_id (shorter; the FK target,
-- users(id), already says what kind of id it is).
--
-- spreadsheet_access: drop granted_by -- only an owner or admin can grant
-- access, and that actor isn't being recorded.
--
-- tabs: created_by / deleted_by make tab lifecycle attribution an explicit,
-- always-queryable fact on the tabs row itself, rather than inferred from
-- spreadsheet_history (which may not have any rows yet for a freshly
-- created, never-edited tab, and offers no enforced guarantee that "the
-- last history row before deleted_at was written by the deleter"). The
-- companion app-level rule (not encoded by this schema): when a tab is
-- deleted, flush its current content to spreadsheet_history first, as a
-- normal save via the existing saved_by/saved_by_ip/saved_by_name columns,
-- so the pre-deletion state is never lost or stale.
-- created_by follows the same 0-is-anonymous convention as saved_by
-- elsewhere (a tab is always created by someone, possibly anonymous).
-- deleted_by is a plain nullable column, not the 0-sentinel convention --
-- it isn't part of any uniqueness constraint, so ordinary NULL ("hasn't
-- happened yet") is the correct and clearest semantics, matching
-- deleted_at right next to it.

ALTER TABLE users
  ADD COLUMN enabled BOOLEAN NOT NULL DEFAULT TRUE AFTER is_admin,
  ADD COLUMN email VARCHAR(255) NOT NULL DEFAULT '' AFTER username;

UPDATE users SET email = '__anonymous__@invalid.local' WHERE id = 0;

ALTER TABLE users
  ADD UNIQUE KEY uq_users_email (email),
  ALTER COLUMN email DROP DEFAULT;

ALTER TABLE spreadsheets
  RENAME COLUMN owner_user_id TO owner_id;

ALTER TABLE spreadsheet_access
  DROP FOREIGN KEY fk_access_granted_by,
  DROP COLUMN granted_by;

ALTER TABLE tabs
  ADD COLUMN created_by BIGINT UNSIGNED NOT NULL DEFAULT 0 AFTER position,
  ADD COLUMN deleted_by BIGINT UNSIGNED NULL DEFAULT NULL AFTER deleted_at,
  ADD CONSTRAINT fk_tabs_created_by
    FOREIGN KEY (created_by) REFERENCES users(id),
  ADD CONSTRAINT fk_tabs_deleted_by
    FOREIGN KEY (deleted_by) REFERENCES users(id);
