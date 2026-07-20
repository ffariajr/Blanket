-- Seeds the id=0 sentinel user representing "anonymous" (no authenticated
-- user). Required before any FK referencing users(id) can store 0.
--
-- MySQL's default behavior treats an explicit 0 inserted into an
-- AUTO_INCREMENT column as "generate the next value" rather than storing
-- literal 0, unless NO_AUTO_VALUE_ON_ZERO is set. Scoped to this session
-- only, and only for this one insert.
SET SESSION sql_mode = (SELECT CONCAT(@@sql_mode, ',NO_AUTO_VALUE_ON_ZERO'));

INSERT INTO users (id, username, password_hash, display_name, is_admin)
VALUES (0, '__anonymous__', '', 'Anonymous', FALSE)
ON DUPLICATE KEY UPDATE id = id;
