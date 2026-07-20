-- Reverts the tabs.created_by / tabs.deleted_by columns added in 0004.
-- Tab creation/deletion attribution is inferred from spreadsheet_history
-- instead of stored directly on the tabs row.
--
-- This requires two app-level rules the schema itself can't enforce:
-- - Tab creation MUST write an initial spreadsheet_history row
--   (sequence = 1) for the new tab_id, even if the tab starts empty,
--   attributed via saved_by/saved_by_ip/saved_by_name to whoever created
--   it. "Who created tab X" = saved_by of the row with MIN(sequence) for
--   that tab_id.
-- - Tab deletion MUST write a final spreadsheet_history row for that
--   tab_id at the moment of deletion (flushing current content),
--   attributed to whoever deleted it -- and no further row may ever be
--   written for that tab_id afterward, or the inference below breaks.
--   "Who deleted tab X" = saved_by of the row with MAX(sequence) for that
--   tab_id, when tabs.deleted_at IS NOT NULL.

ALTER TABLE tabs
  DROP FOREIGN KEY fk_tabs_created_by,
  DROP FOREIGN KEY fk_tabs_deleted_by,
  DROP COLUMN created_by,
  DROP COLUMN deleted_by;
