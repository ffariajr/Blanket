-- Introduces `tabs` as a first-class table (a spreadsheet has one or more
-- named tabs, per the README's "multiple sheets per spreadsheet" feature).
-- Previously tabs existed only as structure inside the workbook-level JSON
-- blob; renaming, reordering, deleting, or listing tabs had no relational
-- home. Now they do.
--
-- spreadsheet_history is restructured to store one JSON snapshot per TAB
-- per save (not the whole workbook), and links only to `tabs` -- not
-- directly to `spreadsheets` -- since tab_id already determines the
-- spreadsheet via tabs.spreadsheet_id. Keeping both would let a row's
-- spreadsheet_id and tab_id disagree; dropping spreadsheet_id here removes
-- that possibility entirely instead of relying on app code to keep them in
-- sync. To get a tab's spreadsheet, join through tabs.
--
-- "Current state of tab X" = the spreadsheet_history row with MAX(sequence)
-- for that tab_id. "Current state of spreadsheet Y" = that, for every
-- non-deleted row in `tabs` where spreadsheet_id = Y, ordered by position.
--
-- "Restore" is now a per-tab operation: copy an old row's `data` for that
-- tab_id forward as a new latest sequence for that tab. Restoring an
-- entire spreadsheet to one past point in time is not directly supported --
-- each tab now has its own independent history -- and would require
-- timestamp-correlating every tab's stream if ever wanted; that's a
-- separate, harder feature, not implemented here.
--
-- No edit-delta/op-log rows (a `save_type` snapshot-vs-edit split was
-- considered and dropped): every spreadsheet_history row is a full,
-- independently-valid snapshot of one tab. Write volume is still cut
-- sharply vs. the original whole-workbook design, since a save now only
-- writes the one tab that changed -- without the replay fragility,
-- undefined compaction policy, and broken whole-spreadsheet restore an
-- edit-log would have introduced.

CREATE TABLE tabs (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  spreadsheet_id BIGINT UNSIGNED NOT NULL,
  name           VARCHAR(255) NOT NULL,
  position       INT UNSIGNED NOT NULL,
  created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at     TIMESTAMP NULL DEFAULT NULL,
  PRIMARY KEY (id),
  KEY idx_tabs_spreadsheet (spreadsheet_id),
  CONSTRAINT fk_tabs_spreadsheet
    FOREIGN KEY (spreadsheet_id) REFERENCES spreadsheets(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

ALTER TABLE spreadsheet_history
  DROP FOREIGN KEY fk_history_spreadsheet,
  DROP KEY uq_history_spreadsheet_sequence,
  DROP COLUMN spreadsheet_id,
  ADD COLUMN tab_id BIGINT UNSIGNED NOT NULL AFTER id,
  ADD UNIQUE KEY uq_history_tab_sequence (tab_id, sequence),
  ADD CONSTRAINT fk_history_tab
    FOREIGN KEY (tab_id) REFERENCES tabs(id) ON DELETE CASCADE;
