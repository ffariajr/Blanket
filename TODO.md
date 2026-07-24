# TODO

## Testing

- ~~**Full exhaustive testing of the mobile version**~~ — done. Found 8
  bugs (touch drag-select non-functional for cells and row/col headers,
  topbar title collapse/overlap, Share dialog buttons pushed off-screen,
  sheets-list long-title overflow, Manage Tabs arrow size, `.btn-small`/
  formula-help notes); all fixed (commits `b50d2fb`..`146a08e`), re-tested
  with a second full mobile exhaustive-testing pass, all 8 confirmed
  genuinely fixed with no regressions. One follow-up regression from the
  Share dialog fix itself (input over-shrinking) found by the retest and
  fixed separately (`8e864aa`). Still worth a manual spot-check by
  Fernando on a real phone for anything genuinely touch/gesture-specific
  that headless Chromium can't fully simulate (e.g. real on-screen-keyboard
  obscuring behavior).

## Known bugs (found during mobile retest, pre-existing, not mobile/touch-specific)

- ~~**Formula-bar's cell-reference label goes stale after a drag-select.**~~
  Fixed, commit `6b8bb14`: `_onMouseMoveDrag` now calls
  `this.onSelectionChange(this.selected)` right after `_highlightRange`, so
  the label tracks the pointer continuously during a plain-mouse
  drag-select instead of only updating on the next unrelated selection
  change. Verified live with real Chromium + puppeteer-core (confirmed the
  bug reproduced on the pre-fix code, confirmed fixed post-fix); deployed.

- ~~**Enter in the formula bar commits the value, then the same keydown
  re-opens the cell for inline editing.**~~ Fixed, commit `6b8bb14`: added
  `e.stopPropagation()` in the formula input's Enter/Escape `onkeydown`
  branches, since `blur()`'s synchronous focus change was otherwise letting
  the same keydown bubble to grid.js's document-level `_onKeyDown` handler
  and reopen inline editing. Verified live with real Chromium +
  puppeteer-core; deployed.

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

- ~~**Dedicated service account for `blanket-ws`**~~ — considered, declined
  (security-concerns.md #2): `blanket-ws` is Blanket-specific by design
  (protocol, `tab_id` routing, auth model), so it could never sensibly be
  shared with a future unrelated site on this box anyway.

- ~~**JWTs land in Apache's access logs**~~ — fixed at the root (security-
  concerns.md #3): the token now travels in the `hello` message instead of
  the connect URL, commit `e2c26bf`. Verified live end-to-end after the
  `blanket-ws` restart — authenticated hello resolves the real identity
  (not anonymous) and persists correctly; anonymous (no token) unaffected.

- ~~**No `Origin` header validation on the WS handshake**~~ — done, commit
  `303a435`, live since the `blanket-ws` restart.
