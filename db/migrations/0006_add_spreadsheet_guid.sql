-- Adds a GUID to spreadsheets for shareable URLs (church.dogmanjr.net/blanket/#/s/<guid>),
-- so the URL someone is currently viewing IS the share link -- no separate
-- "get share link" step. Nullable here on purpose: existing rows need a
-- real, randomly-generated (not MySQL UUID(), which is v1/time+MAC-based
-- and materially more guessable -- unacceptable for something that grants
-- access-adjacent visibility to a spreadsheet) value backfilled by a PHP
-- script before NOT NULL + UNIQUE can be added in 0007.

ALTER TABLE spreadsheets
  ADD COLUMN guid CHAR(36) NULL AFTER id;
