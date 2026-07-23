# TODO


## Step 1 - API surface

I want to be able to do the following via API REST:
	- query my spreadsheets, filter with "TEMPLATE" in the name
	- duplicate that one with a new name
	- do a find and replace to replace all placeholder text in every/some cells/rows/cols in one/specific/all tabs
	- set anonymous sharing settings


## Known bugs (not yet fixed, deciding on approach later)

- **Copy/pasting formulas with cell references has a bug.** Fernando hit
  this but hasn't described the exact symptom/reproduction yet — follow up
  with him for specifics before attempting a fix. One solution direction
  he's floated: move cell referencing to a new custom syntax (something
  like `@#@#`-style) instead of the current Excel-style `A1`/`$A$1`
  notation, presumably to sidestep whatever ambiguity is causing the bug.
  This would be a significant change (parser, `shiftFormulaReferences`/
  `shiftReferencesForStructuralChange`, the help dialog, CELL_SCHEMA.md,
  and anyone's existing formulas already using `A1`-style refs) — decide
  on the actual approach once the bug itself is understood, don't jump
  straight to a syntax change without confirming it's the right fix for
  whatever's actually broken.

## Testing

- **Full exhaustive testing of the mobile version**, in subagents (same
  pattern as the earlier desktop-feature testing workflows) — hasn't been
  done yet. A real (headless) Chromium can actually be driven on this box
  now — see the `browser-testing-workaround` memory — so this can use real
  browser testing with a mobile viewport/user-agent set via Chrome's own
  CLI flags, not just jsdom. Still worth a manual spot-check by Fernando on
  an actual phone for anything genuinely touch/gesture-specific.

## Step 2 - Hardening & Cleanup

Final hardening/cleanup backlog. Nothing here is urgent or a known active
exploit — see security-concerns.md for full detail on each.

- **Narrow the `blanket` MySQL user's grants.** `SHOW GRANTS` shows
  `ALL PRIVILEGES ON blanket.*`; the app only ever does
  SELECT/INSERT/UPDATE/DELETE through prepared statements, never DDL.
  Narrowing reduces blast radius if the app is ever compromised. Data-model/
  access decision — flagging for a decision rather than just running it:
  ```sql
  REVOKE ALL PRIVILEGES ON blanket.* FROM 'blanket'@'dogmanjr.net';
  GRANT SELECT, INSERT, UPDATE, DELETE ON blanket.* TO 'blanket'@'dogmanjr.net';
  ```
  (Confirm nothing — migrations included — relies on this same credential
  having DDL rights before running this.)

- **Dedicated service account for `blanket-ws`**, instead of sharing
  `www-data` with the PHP app (security-concerns.md #2). Recommended, not
  mandatory — narrows blast radius if either service is compromised, at
  the cost of new-user setup. Root-only.

- **JWTs land in Apache's access logs** as a URL query parameter on every
  WS handshake (security-concerns.md #3). Worth a custom `LogFormat` that
  redacts the query string for `/blanket/ws/`, or a deliberate decision
  that log retention/access is fine as-is. Root-only.

- **No `Origin` header validation on the WS handshake** (security-concerns.md
  #5). Low priority — the main exploit path is already closed by JWTs
  living in `localStorage`, not a cookie. Code-level, no root needed.
