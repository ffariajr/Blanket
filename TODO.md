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

## Performance tradeoffs — deferred, needs sizing before deciding

- **Grid DOM virtualization (windowing).** BUGS_FOUND.md [021] and [024] are
  the same root cause measured two ways: `assets/js/grid.js`'s `_build()`/
  `_renderAll()` unconditionally creates one real `<tr>`/`<td>` per row/cell
  across the whole `this.rows x this.cols` grid, with no windowing to only
  the rows/columns actually visible in the scroll viewport. [021] shows a
  real, roughly-linear ~4x cold-load slowdown and modest scroll jank at
  10,000 cells (still passing at that size); [024] shows mobile touch-scroll
  fps genuinely degrading (~50fps → ~25fps) once a sheet grows to roughly
  2-4x that same tested scale (~11,000 → ~40,000 cells). Both are currently
  passing, not active bugs — Fernando has explicitly decided not to
  virtualize right now. This entry is the sizing/risk writeup for revisiting
  that call later, not a plan to implement it.

  Rough size: **large, 1-2+ weeks**, not a contained render-layer swap. The
  reason it's not small: grid.js has no abstraction between "cell state" and
  "DOM node" — nearly every subsystem reaches directly into live `<td>`
  elements rather than going through `this.cells` alone, so virtualizing the
  render layer ripples through most of the file's ~2100 lines, not just
  `_build`/`_renderAll`/`_renderCell`:
  - **Cell lookup assumes every ref has a live node.** `_cellEl()` is a flat
    `ref -> td` Map (`this._cellElements`) built once per `_build()`; every
    other method (`_renderCell`, `_highlightRange`, `_beginEdit`,
    `applyRemote`'s per-cell branch, `_recalcDependents`) calls it and
    silently no-ops (`if (!el) return`) when the ref isn't currently
    rendered. That "no-op if off-screen" behavior is exactly wrong for
    virtualization — a scrolled-off cell whose value changes (a remote edit,
    a formula recalculating) has to update `this.cells` correctly so that
    scrolling it back into view renders the right value, even though today
    the no-op silently (and correctly, for a fully-rendered grid) does
    nothing.
  - **Selection/highlighting is DOM-classList-based, not state-based.**
    `_highlightRange()` does `querySelectorAll('td.selected')` then adds the
    class to each ref's live element. A virtualized grid has to instead
    track "selected refs" as data and apply the class only to whichever of
    those refs currently have a mounted node, then re-apply on every
    scroll-driven remount — a real behavioral change, not just an optimization.
  - **Remote presence selection highlights are applied from OUTSIDE grid.js
    entirely.** `assets/js/app.js`'s `renderRemoteSelections()` calls
    `grid._cellEl(ref)` directly and toggles `.remote-selected` on whatever
    it gets back, and is explicitly re-run via `grid.onRebuild` after every
    `_build()` because `_build()` wipes DOM styling app.js applied directly
    (see the `onRebuild` doc comment in grid.js, ~line 161-167). Virtualized
    scrolling would need a `onRebuild`-equivalent hook fired on every
    scroll-driven remount too, not just on structural rebuilds — otherwise
    another viewer's live selection highlight silently vanishes the moment
    the local user scrolls.
  - **Merge/covered-cell logic (`_isCovered`/`_originOf`/`_computeCoverage`)**
    already assumes the DOM structure (colSpan/rowSpan on the origin `<td>`,
    no `<td>` at all for covered cells) mirrors `this.cells` state exactly.
    A virtualized viewport that windows on row boundaries has to guarantee
    it never starts a rendered window in the middle of a rowSpan — the
    origin row must always be part of the same rendered window as every
    row it spans, or `_syncRowCellHeights`/`_renderCell`'s merge-height skip
    logic breaks.
  - **Every input path locates a cell via `e.target.closest('td')` or
    `td.dataset.ref`**: `_onMouseDown`, `_onMouseMoveDrag`, `_onCellDblClick`,
    `_onContextMenu`, `_onTouchStart`/`_onTouchMove` (which additionally uses
    `document.elementFromPoint()` mid-drag, since touchmove's `e.target`
    stays pinned to the touchstart target). Drag-select across a
    virtualized boundary (dragging past the currently-rendered window's
    edge) has no `<td>` to hit-test against past that edge — the drag
    logic would need to fall back to computing the target ref from
    scroll position/geometry instead of DOM hit-testing once the pointer
    leaves the rendered window, entirely new logic, not a tweak.
  - **Resize handles** (`_colResizeHandle`/`_rowResizeHandle`) are only ever
    attached to headers within the rendered window — fine for columns
    (headers are cheap, could stay always-rendered even if data columns are
    windowed), but row-resize handles on off-screen rows wouldn't exist to
    grab in the first place, meaning "resize row 500 without scrolling to
    it" (not something you can do today anyway, but not something today's
    code prevents structurally) would need explicit handling.
  - **Keyboard arrow-key traversal (`_moveSelection`)** just recomputes a ref
    and calls `_select()`, which is state-only — but landing the selection
    on a ref with no live node (arrowed off the current viewport) means
    `_select()`/`_highlightRange()`'s `_cellEl()` lookups fail silently
    today; a virtualized version has to scroll the new selection into view
    AND mount it before highlighting, a new responsibility this method
    doesn't have.
  - **`ACTIONGROUP` button rendering/click handling** (`_renderActionGroupCell`)
    attaches real `<button>` click listeners per rendered cell — harmless
    under virtualization (buttons off-screen just don't exist until
    scrolled into view, same as any other cell), but confirms buttons can't
    be "pre-warmed"; a button someone scrolls away from mid-async
    `onNeedUserInfo()` prompt would need the in-flight state to survive
    remounting, not just re-rendering.
  - **Copy/paste range ops** (`_selectionToTsv`, `_applyTsvAtSelection`,
    `_clearSelection`, `applyFormatToSelection`) already iterate `this.cells`/
    computed ref lists, not live DOM — these are largely fine as-is, since
    they call `_renderCell(ref)` per affected ref, which already safely
    no-ops for a ref with no live node today. This is the one area that's
    close to virtualization-ready already.

  Given how much of grid.js reaches into `<td>` elements directly instead of
  through the `this.cells` abstraction, this is not a contained change to
  the render layer alone — it touches selection, drag-select (mouse and
  touch), merge rendering, remote-patch application, presence highlighting,
  and keyboard traversal simultaneously. Per TESTING_PLAN.md, Section A
  (full functional regression) and Section B (mobile regression/parity)
  both exercise dialogs, context menus, drag-select, and `ACTIONGROUP`
  scenarios that all touch cell rendering directly — a full re-run of both
  sections would be warranted after this change, not a narrow perf-only
  spot check, given several of grid.js's already-fixed bugs (e.g. [025],
  Section G #1) were themselves regressions in exactly this "does the DOM
  state match selection state" territory.

  **Cheaper partial mitigation worth considering instead of full 2D
  virtualization:** windowing rows only, and leaving all columns real. Real
  church-spreadsheet usage is far more likely to be row-heavy (growing
  member/attendance/giving lists) than column-heavy (a fixed, small set of
  fields) — column count in the tested scales above stayed in the tens
  while row count drove the cell-count growth. Row-only virtualization
  avoids the horizontal hit-testing problem entirely (every row still has
  every column's `<td>`, so `closest('td')`/`elementFromPoint` keep working
  unchanged within a rendered row), and only has to solve the vertical
  window-boundary problems above (rowSpan merges crossing a window edge,
  scrolling a selection/highlight into view, row-resize handles outside the
  window). Rougher size for that narrower version: **medium, a few days**,
  still requiring a Section A/B re-test of anything selection- or
  merge-related, but a meaningfully smaller and lower-risk slice than full
  row+column virtualization.
