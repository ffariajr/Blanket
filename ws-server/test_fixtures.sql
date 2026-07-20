-- Throwaway test fixtures for manual WS server verification. Deleted by
-- test_cleanup.sql afterward.
INSERT INTO users (username, email, password_hash, display_name, is_admin)
VALUES ('ws_test_owner', 'ws_test_owner@example.invalid', 'x', 'WS Test Owner', 0);
SET @owner_id = LAST_INSERT_ID();

INSERT INTO users (username, email, password_hash, display_name, is_admin)
VALUES ('ws_test_editor', 'ws_test_editor@example.invalid', 'x', 'WS Test Editor', 0);
SET @editor_id = LAST_INSERT_ID();

INSERT INTO spreadsheets (owner_id, title) VALUES (@owner_id, 'WS Test Sheet');
SET @spreadsheet_id = LAST_INSERT_ID();

INSERT INTO tabs (spreadsheet_id, name, position) VALUES (@spreadsheet_id, 'Sheet1', 0);
SET @tab_id = LAST_INSERT_ID();

INSERT INTO spreadsheet_access (spreadsheet_id, user_id, access_level)
VALUES (@spreadsheet_id, @editor_id, 'edit');

-- A second tab on the same spreadsheet with NO anonymous access row, to
-- verify anonymous connections are rejected by default.
INSERT INTO tabs (spreadsheet_id, name, position) VALUES (@spreadsheet_id, 'Sheet2-NoAnon', 1);

-- A second spreadsheet with anonymous view-only access, and a tab on it,
-- to verify the anonymous-with-explicit-policy path.
INSERT INTO spreadsheets (owner_id, title) VALUES (@owner_id, 'WS Test Anon Sheet');
SET @anon_spreadsheet_id = LAST_INSERT_ID();
INSERT INTO tabs (spreadsheet_id, name, position) VALUES (@anon_spreadsheet_id, 'AnonSheet1', 0);
INSERT INTO spreadsheet_access (spreadsheet_id, user_id, access_level)
VALUES (@anon_spreadsheet_id, 0, 'view');

SELECT @owner_id AS owner_id, @editor_id AS editor_id, @spreadsheet_id AS spreadsheet_id, @tab_id AS tab_id, @anon_spreadsheet_id AS anon_spreadsheet_id;
