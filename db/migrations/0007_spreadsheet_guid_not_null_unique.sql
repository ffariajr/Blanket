-- Follow-up to 0006: run only after every existing spreadsheets row has a
-- backfilled guid (see the backfill step in the deploy/dev notes -- this
-- migration will fail on any remaining NULL). Enforces the invariant going
-- forward: every spreadsheet has exactly one, unique, non-null guid.

ALTER TABLE spreadsheets
  MODIFY COLUMN guid CHAR(36) NOT NULL,
  ADD UNIQUE KEY uq_spreadsheets_guid (guid);
