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

  ---

  ### Addendum: Claude-Code-specific re-assessment (contrarian re-read, same
  scope, same commit as the original writeup above)

  The "1-2+ weeks" / "few days" framing above reads as generic human-developer
  calendar time. Fernando asked for a second, adversarial pass specifically
  addressing whether that unit even applies given how this project has
  actually been worked all session: parallel Claude Code subagents across
  isolated git worktrees, real-Chromium/puppeteer-core verification (not
  mocked), independent adversarial re-verification catching real bugs before
  merge (e.g. the `a56f5b6` admission-race fix, caught by a second agent
  re-checking `dca21fe`'s mitigation), and full sweeps completing in hours,
  not days — concretely, this exact repo's own commit timestamps show
  `a494153` (start of TESTING_PLAN.md) at 06:56 through `f9a9feb` ([023]'s
  fix landing) at 16:05 the same day: a from-scratch testing plan, a full
  Section A-G regression sweep across auth/formulas/ACTIONGROUP/collab/
  structural-ops/grid-UI/mobile with independent verification, 32 bugs fixed
  and merged from 9 parallel worktrees (`b941fb4`..`20fc1a6`, all 9 merges
  landing within a 29-minute window), a WS presence race mitigated and then
  hardened after an independent-agent-caught bug, and a full repository/query
  refactor (owned/shared split + new UI) — all in under 9.5 hours of wall
  clock, in one day. Re-read `assets/js/grid.js` in full (all 2182 lines, not
  just the original writeup's summary) to check the estimate against that
  demonstrated mode of working, independently, before answering.

  **Independent read of grid.js confirms the coupling claims above are
  accurate, if anything slightly understated.** Every subsystem the original
  writeup lists really does reach into live `<td>` state directly:
  `_cellElements` (a flat ref->td Map built once per `_build()`, `_cellEl()`
  silently no-ops off it everywhere), `_highlightRange()` (DOM classList
  scan+toggle, not selected-refs-as-data), `app.js`'s `renderRemoteSelections()`
  (calls `grid._cellEl(ref)` from *outside* grid.js entirely, wired back in
  only via the `onRebuild` hook — confirmed at `assets/js/app.js:493-544,659`),
  merge/coverage (`_computeCoverage`/`_isCovered`/`_originOf`, colSpan/rowSpan
  baked into DOM structure), every input path's `e.target.closest('td')` or
  `document.elementFromPoint()` hit-testing (`_onMouseDown`,
  `_onMouseMoveDrag`, `_onCellDblClick`, `_onContextMenu`, `_onTouchStart`,
  `_onTouchMove`), resize handles, and keyboard traversal (`_moveSelection`).
  One thing worth adding to the original list: `_build()` today is the single
  entry point for BOTH "the document's structural state changed" (merge,
  remote structural patch, insert/delete row/col) AND "render every cell,"
  with no existing concept of "recompute the visible window" as something
  separate from either. Virtualizing has to introduce that third concept from
  scratch, not just adapt the existing two — a real, currently-nonexistent
  abstraction, not a variant of `_build()`.

  **What's genuinely sequential vs. parallelizable, and why this is a WORSE
  fit for the worktree-fan-out pattern than the 32-bug round was.** The core
  windowing/mount-unmount abstraction (tracking which refs are currently
  mounted, a scroll-driven recompute of the visible window, incremental
  mount/unmount, a stable hook other code can subscribe to for "a ref just
  (un)mounted" replacing `onRebuild`) has to land first and be API-stable
  before any of the ~8 call-site adaptations can even be written against it,
  let alone verified — genuinely serial, no way around it regardless of agent
  count. But the follow-on work is NOT like the 32-bug round's fan-out,
  where each bug lived in a different file/function with near-zero overlap
  (`presence.py`, `TabController.php`, `formulas.js`, distinct `grid.js`
  methods, dialog code, CSS) and could be handed to 9 isolated worktrees with
  almost no merge friction. Here, most of the ~8 subsystems requiring rework
  — selection highlighting, drag hit-testing, keyboard traversal, presence
  overlay reapplication, merge-boundary guarantees — all live inside or
  directly call the SAME small cluster of already-interdependent methods
  (`_select`/`_highlightRange`/`_onMouseDown`/`_onMouseMoveDrag`/
  `_onTouchMove`/`_moveSelection`, plus `app.js`'s `renderRemoteSelections`).
  Splitting that cluster across parallel worktrees would mean 8 agents
  editing overlapping regions of the same ~300 lines simultaneously — an
  integration/merge-conflict cost that would likely burn more wall clock than
  it saves. The honest parallelization win here is smaller than the mandate's
  framing implies: realistically one agent, working through the adaptations
  sequentially against the now-stable foundation API, with tight
  real-browser verification per subsystem as it goes — not an 8-way fan-out.
  (Copy/paste range ops are the one piece that genuinely is
  already-independent and separable, per the original writeup — that one
  could go to its own worktree/pass with little risk.)

  **What's wall-clock-bottlenecked regardless of agent speed.** Two things,
  neither compressible by throwing more Claude Code at them: (1) the
  touch-gesture code has real, deliberately-chosen timers baked into its own
  logic (`TOUCH_DRAG_ARM_MS` = 350ms, `TOUCH_LONG_PRESS_MENU_MS` = 550ms) that
  any real-device verification has to actually wait out per scenario, not
  something an LLM can think its way past; (2) TESTING_PLAN.md's own Section
  A (7 major dimensions: auth, formula engine, ACTIONGROUP/USERINFO, realtime
  collab, structural ops, grid UI, deployment hardening) and Section B (full
  mobile regression + a feature-parity re-audit of every Section A item via
  touch) are both explicitly called for after a change this invasive — real
  page loads, real scroll/touch/frame-rate measurement (the kind [021]/[024]
  themselves used: 120 rAF-driven scroll steps, 5 fresh Chromium launches per
  condition, real touchscreen event sequences), and, per this project's own
  now-established practice, an independent second-agent adversarial
  reverification pass on top of the first (as was actually done for [021],
  [022], [023], [024], and the 32-bug round). This is the same class of work
  that took this project's own original Section A-G sweep about 3h45m of wall
  clock (`a494153` 06:56 to `c686472`/`60a3962` ~10:39, the same day) even
  with real parallel testing agents already in play — a comparably-scoped
  re-test after virtualization should be expected to cost a similar order of
  magnitude, not zero, no matter how fast the code itself gets written.

  **Revised estimate.** Full 2D row+column virtualization, executed the way
  this project actually works (foundation-first, sequential adaptation
  against it, then a genuinely real-browser-bound regression pass): roughly
  **2-3 focused Claude-Code sessions, on the order of 8-20 hours of total
  wall clock**, not 1-2 calendar weeks — but also not something that
  compresses to "an afternoon" just because an LLM writes the code fast,
  because (a) the foundation-then-adapt structure is genuinely serial and
  (b) the required regression re-test has a real wall-clock floor this
  project has already empirically measured at several hours for a
  comparably-scoped sweep. The row-only partial mitigation compresses further
  than "a few days" suggests, plausibly to **one focused session, well under
  a full day of wall clock** — it removes the single hardest item (cross-
  window hit-testing) entirely, leaving a materially smaller, still-serial-
  but-short foundation step plus a narrower regression slice (selection/
  merge-related scenarios, not the full A/B sweep).

  **Verdict: the original estimate is directionally right about relative
  risk and scope (full virtualization is genuinely much bigger and riskier
  than row-only; both writeups' architectural claims independently check
  out against the full 2182-line file) but the "1-2+ weeks" / "few days"
  UNITS are calendar-time framing that doesn't transfer to this project's
  demonstrated Claude-Code-native mode of work.** Read as wall clock, both
  numbers are meaningfully too pessimistic on time — but not for the naive
  reason ("Claude Code writes code fast, so parallelize harder"); the real
  correction is that this particular change parallelizes WORSE than the
  32-bug round did (shared, already-entangled code, not disjoint files), and
  the actual floor is a mix of one unavoidably-serial foundation step and a
  real-browser regression-test wall-clock cost this project has already
  measured directly, not a raw code-authoring speed limit.
