// Grid rendering + editing. Per-tab, resizable dimensions (this.cols/
// this.rows -- see CELL_SCHEMA.md "cols/rows"), not a fixed global canvas
// -- a new tab defaults to 6 cols (A-F) x 20 rows (set server-side, see
// TabController::DEFAULT_COLS/DEFAULT_ROWS) and grows/shrinks via
// insertRowsAt/deleteRowsAt/insertColumnsAt/deleteColumnsAt below.
// Sparse cell data: {"A1": {value, format, merge}}.
import {
  isFormula, evaluateFormula, colLetter, parseRef, parseActionGroup,
  shiftFormulaReferences, shiftReferencesForStructuralChange, shiftActionGroupReferences,
  extractReferences,
} from './formulas.js?v=__DEPLOY_VERSION__';
import { getUserInfoField, setUserInfoField, deleteUserInfoField } from './api.js?v=__DEPLOY_VERSION__';

/**
 * A cell's `value` is normally a string (literal or "=formula") -- every
 * write path the app itself uses (setCellValue et al.) only ever puts a
 * string there. Pre-existing data written directly to the DB, bypassing
 * the app entirely, can hold a `value` of any JSON type though. Numbers/
 * booleans stringify to something sensible and match how every other
 * malformed shape on a tab already degrades gracefully (blank, or a
 * plain string coercion) -- but a plain object (or array) has no sensible
 * string form: naive `String(anObject)`/textContent-assignment always
 * produces the useless literal "[object Object]", which is a real value
 * a user could see and be confused by, not a graceful degrade. Guard for
 * that one shape specifically and fall back to blank, same as the other
 * malformed shapes already do via this file's own falsy/undefined-
 * property fallbacks elsewhere.
 */
export function displayableCellValue(raw) {
  if (raw === null || raw === undefined) return '';
  const t = typeof raw;
  return t === 'string' || t === 'number' || t === 'boolean' ? raw : '';
}

/**
 * Executors for ACTIONGROUP's action types, keyed by action.type -- the
 * runtime counterpart to formulas.js's ACTION_ARG_PARSERS (parsing lives
 * there, execution lives here since it needs Grid's cookie/DOM access).
 * A new action type is added by adding one entry here and one there,
 * without touching _runActionGroup. Each executor resolves the action's
 * value for the current viewer given `resolved` (a plain infoType->value
 * map _runActionGroup already collected up front, see there), returning
 * null/undefined if unresolvable -- _runActionGroup skips writing that
 * action's target cell in that case, but still runs the rest. Executors
 * don't prompt for missing values themselves -- that's a UI concern
 * (app.js's onNeedUserInfo), not this registry's; keeps this file's usual
 * data-layer/UI-layer split (see the contextmenu/mergeSelection comments
 * elsewhere in this file) intact for actions too.
 */
const ACTION_EXECUTORS = {
  USERINFO(action, resolved) {
    return (resolved && resolved[action.infoType]) || getUserInfoField(action.infoType) || null;
  },
};

/**
 * Parallel to ACTION_EXECUTORS: for an action type with a user-resolvable
 * field, returns {key, value, displayText, validValues} (value = its
 * current cookie/account value, possibly '') so _runActionGroup can collect
 * every field referenced anywhere in the group -- across every action, not
 * just the ones missing a value -- and decide as a whole whether to show
 * app.js's consolidated onNeedUserInfo dialog (only if at least one is
 * missing) with all of them listed (so an already-known field is shown
 * pre-filled/editable, not hidden). displayText/validValues travel with the
 * field so showUserInfoPrompt() can label it properly and render a dropdown
 * instead of free text when the formula author supplied valid values (see
 * USERINFO's own doc comment in formulas.js). A future action type with its
 * own resolvable field plugs in here the same way, without _runActionGroup
 * itself knowing anything about "infoType" or USERINFO specifically.
 */
const ACTION_NEEDS = {
  USERINFO(action) {
    return {
      key: action.infoType,
      value: getUserInfoField(action.infoType),
      displayText: action.displayText,
      validValues: action.validValues,
    };
  },
};

// Fallback for a document saved before per-tab dimensions existed (no
// `cols`/`rows` keys at all) -- the old fixed size, so pre-existing data
// doesn't lose visibility into cells beyond the new 6x20 default. Every
// NEW tab always has explicit cols/rows from creation on (see
// TabController::create()), so this only ever matters for old data.
const LEGACY_COLS = 30; // A..AD
const LEGACY_ROWS = 100;
const DEFAULT_COL_WIDTH = 96;
const DEFAULT_ROW_HEIGHT = 28;
const MIN_COL_WIDTH = 32;
const MIN_ROW_HEIGHT = 18;
// How long a touch has to hold still before it's treated as "starting a
// drag-select" rather than "starting a scroll" -- see _onTouchStart.
const TOUCH_DRAG_ARM_MS = 350;
const TOUCH_DRAG_ARM_PX = 10;
// A hold that's still going (with zero movement at all since touchstart)
// this much longer than the drag-arm point above is treated as a genuine
// long-press-to-open-context-menu gesture instead, matching the mouse
// right-click/contextmenu path -- see _armTouchDragCandidate/_onTouchMove.
// Must be strictly greater than TOUCH_DRAG_ARM_MS so the drag-arm's own
// single-cell/row/col selection has already happened by the time this
// fires (the menu then applies to that same selection, exactly like
// _onContextMenu's own "select first, then open menu" order).
const TOUCH_LONG_PRESS_MENU_MS = 550;
// The row-header <col> (row numbers, leftmost) never had an explicit
// width -- under table-layout:auto (before the resize-squeeze fix) that
// was fine, content sized it. Under table-layout:fixed, a <col> with no
// specified width only gets whatever's left over after every OTHER
// column's specified width is subtracted from the table's own width --
// and the table's width was being set to exactly the sum of the data
// columns alone (_sumColumnWidths), leaving zero left over. The row
// header column collapsed to ~0px and effectively vanished. Fixed width
// here, and _sumColumnWidths()/the live-drag width sync both now
// account for it.
const ROW_HEADER_WIDTH = 40;
const MIN_COLS = 1;
const MIN_ROWS = 1;

// --- Virtualization (windowed rendering) ------------------------------
// Only rows/columns within the visible range +/- a buffer get real
// <tr>/<td> nodes (see _computeVisibleWindow/_renderWindow) -- everything
// else is represented by one spacer <tr>/<td> per side, sized to occupy
// the same total pixel space the skipped rows/columns would have taken,
// so the scroll container's scrollable size/position stays correct. The
// buffer is a FRACTION of the current viewport size (floored at the *_PX
// minimums below) rather than a fixed row/column count -- it needs to
// survive a fast scroll/fling without a visible blank flash regardless of
// how small rowHeights/columnWidths happen to be, and a fixed pixel
// buffer scales naturally with viewport size for that (a bigger viewport
// scrolls faster in practice, roughly speaking, so it gets a bigger
// buffer too).
const MIN_ROW_BUFFER_PX = 150;
const MIN_COL_BUFFER_PX = 150;
const BUFFER_VIEWPORT_FRACTION = 0.15;
// The raw visible+buffer range (see _computeVisibleWindow) shifts by a row
// or two on nearly every scroll event during a real, continuous scroll
// gesture -- rebuilding the whole windowed <tbody> that often (even though
// each individual rebuild is itself cheap and bounded) adds up to real
// scroll jank, confirmed by profiling this exact scenario (see this
// commit's perf write-up). Snapping the window's start/end to a coarse
// row/column "chunk" grid (rounding the start down and the end up to the
// nearest chunk boundary) means the actually-rendered window only changes
// once scrolling crosses a whole chunk, cutting rebuild frequency by
// roughly ROW_CHUNK/COL_CHUNK-fold for a modest, still-bounded increase in
// how many rows/columns stay mounted at once. Snapping only ever WIDENS
// the raw range (floor down, ceil up), never narrows it, so it can't
// undo the buffer's or the merge-safety expansion's coverage guarantees --
// safe to apply as the last step.
const ROW_CHUNK = 32;
const COL_CHUNK = 16;

export { colLetter };

export class Grid {
  /**
   * @param {HTMLElement} container
   * @param {object} opts.document {cells, columnWidths, rowHeights, cols,
   *   rows} -- the full tab document shape (see CELL_SCHEMA.md).
   *   columnWidths/rowHeights are sparse (col letter / row number -> px
   *   override). cols/rows are the grid's actual dimensions -- falls back
   *   to LEGACY_COLS/LEGACY_ROWS if absent (a document saved before this
   *   feature existed).
   * @param {(patch: object, structuralOp?: {dimension: 'row'|'col',
   *   boundaryIndex: number, count: number, isInsert: boolean}) => void}
   *   opts.onChange called with a full-document-shaped merge patch (e.g.
   *   {cells: {...}} or {columnWidths: {...}}) on any local edit -- this is
   *   the wire shape ws-server/merge_patch.py expects, and the ONLY place
   *   that shape is assembled, so callers (app.js) never need to know about
   *   it. The second argument is present ONLY for a local insert/delete row/
   *   column (from _transformStructure) -- app.js/ws.js thread it through as
   *   a sibling of the merge-patch payload (never merged into the patch
   *   itself, so it's never persisted into the document) purely so OTHER
   *   connected viewers' applyRemote() can remap their own scroll anchor by
   *   the same boundaryIndex/count/isInsert the LOCAL editor used -- see
   *   applyRemote's structural branch and _remapStructuralIndex.
   * @param {boolean} opts.readOnly
   * @param {(fields: Array<{infoType: string, value: string}>) =>
   *   Promise<Record<string,string>|null>} [opts.onNeedUserInfo] called by
   *   _runActionGroup when an ACTIONGROUP click needs one or more
   *   USERINFO fields it doesn't already have -- app.js's job to render an
   *   actual dialog (this file has no dialog machinery of its own); resolve
   *   with an infoType->value map (blank/omitted entries are treated as
   *   skipped) or null to skip everything. Defaults to always skipping, so
   *   a Grid built without this option (e.g. a future test harness) still
   *   works, just without ever resolving a missing field.
   */
  constructor(container, { document: doc, onChange, readOnly, onNeedUserInfo }) {
    this.container = container;
    doc = doc || {};
    this.cells = doc.cells || {};
    this.columnWidths = doc.columnWidths || {};
    this.rowHeights = doc.rowHeights || {};
    this.cols = doc.cols || LEGACY_COLS;
    this.rows = doc.rows || LEGACY_ROWS;
    this.onChange = onChange || (() => {});
    this.onNeedUserInfo = onNeedUserInfo || (() => Promise.resolve(null));
    this.readOnly = !!readOnly;
    this.selected = null; // ref string
    this.anchor = null; // for range selection
    this.editingInput = null;
    this._dragging = false;
    this._headerDragging = null; // 'row'|'col'|null -- see _onRowHeaderMouseDown/_onColHeaderMouseDown
    // Drag-select auto-scroll state (mouse AND touch, see
    // _startDragAutoScroll/_dragAutoScrollTick) -- an interval, not just
    // mousemove-driven, so a pointer held stationary at the viewport edge
    // still keeps advancing the window (mousemove stops firing once the
    // pointer itself stops moving).
    this._dragAutoScrollTimer = null;
    this._lastPointerXY = null; // {x, y} in viewport (clientX/clientY) coords, updated on every drag-relevant move
    this._touchDragCandidate = null; // {kind, ref|index, x, y, armed} -- see _onTouchStart
    this._touchDragTimer = null;
    this._headerAnchorRow = null; // anchor row/col for a whole-row/column selection -- see selectWholeRow/Column
    this._headerAnchorCol = null;
    this._resizing = null; // {kind: 'col'|'row', key, startPx, startSize, el}
    this.onSelectionChange = null; // set by app.js: (ref) => void, for the formula bar
    // set by app.js: () => void, called at the end of every _build() --
    // needed because _build() replaces this.table wholesale (merge/
    // unmerge, remote merge patches, resize all trigger it), which would
    // otherwise silently wipe any DOM-level styling app.js applies
    // directly to cells (e.g. remote-viewer selection highlights) without
    // this hook telling app.js to reapply it after a rebuild.
    this.onRebuild = null;
    // Set by (future) app.js code: () => void, called every time the
    // windowed render mounts a different row/column range -- on scroll,
    // on a container resize, and as part of every _build() too (a
    // structural rebuild always re-renders the window). Structurally
    // analogous to onRebuild above, but fires on every remount, not just a
    // full structural rebuild -- app.js's remote-selection-highlight
    // reapplication (currently wired only to onRebuild, see there) will
    // need to also listen here once scrolling alone can change which refs
    // are mounted without any structural change happening at all. Not
    // wired to anything yet; existing until the next phase does that.
    this.onWindowChange = null;
    // In-app clipboard fallback for when the OS Clipboard API is
    // unavailable (non-secure context, permission denied) -- copy/paste
    // still work within the app itself either way.
    this._internalClipboard = '';
    this._internalClipboardOrigin = null; // {col,row} the last copy's top-left came from -- see _applyTsvAtSelection
    // Document-level listeners attach ONCE here, not in _build() -- _build()
    // now runs repeatedly (merge/unmerge/applyRemote-with-merge each force
    // a structural rebuild, see applyRemote below), and re-registering
    // document-level listeners on every rebuild would leak duplicates
    // (each keypress/paste/mouseup firing once per accumulated rebuild).
    // Safe to bind once: every handler reads current instance state
    // (this.table, this.selected, ...) at call time, not at bind time, so
    // none of them care that this.table gets replaced by later rebuilds.
    document.addEventListener('mouseup', () => this._onMouseUp());
    document.addEventListener('touchend', (e) => this._onTouchEnd(e));
    document.addEventListener('touchcancel', (e) => this._onTouchEnd(e));
    document.addEventListener('keydown', (e) => this._onKeyDown(e));
    document.addEventListener('paste', (e) => this._onPaste(e));
    document.addEventListener('copy', (e) => this._onCopy(e));
    document.addEventListener('mousemove', (e) => this._onResizeMove(e));
    document.addEventListener('mouseup', () => this._onResizeEnd());
    // Bound once on the container (which persists across _build() rebuilds,
    // unlike this.table) -- contextmenu on a cell or a row/col header opens
    // a custom menu instead of the browser's native one. app.js listens for
    // the 'gridcontextmenu' CustomEvent this dispatches to actually render
    // the menu (grid.js has no dialog/menu-positioning machinery of its
    // own, same division of responsibility as mergeSelection()'s {ok,error}
    // return -- grid.js does the data operation, app.js does the UI).
    this.container.addEventListener('contextmenu', (e) => this._onContextMenu(e));
    // Keyboard-only entry point: every <td> is tabIndex=-1 (see _build())
    // and _onKeyDown early-returns whenever this.selected is unset, so
    // without this the grid was completely unreachable via Tab alone --
    // arrow-key traversal (_moveSelection) only ever moves an *existing*
    // selection, it can't create the first one. Making the scroll
    // container itself a real, explicit tab stop and establishing a
    // selection the first time it receives focus (if nothing is already
    // selected -- e.g. a prior mouse/touch click) gives keyboard-only
    // users a way in, after which the existing arrow-key handling takes
    // over normally.
    this.container.tabIndex = 0;
    this.container.addEventListener('focus', () => this._onContainerFocus());
    // Tracks the most recent mousedown's button, read by _onContainerFocus
    // to decide whether to skip its auto-select-first-cell-and-scroll
    // cascade -- see there. Bound at the container level (not table/
    // header-specific) so it also sees a right-click landing on a row/col
    // header BEFORE _onRowHeaderMouseDown/_onColHeaderMouseDown get a
    // chance to early-return for button!==0 (this needs the raw button,
    // not whatever those handlers decided to do with it), and fires during
    // the mousedown's own dispatch -- synchronously before the browser's
    // default focus-shift action for that same mousedown runs -- so
    // _onContainerFocus always sees an up-to-date value for the mousedown
    // that's causing it, never a stale one from some earlier gesture.
    this.container.addEventListener('mousedown', (e) => {
      this._lastMouseDownButton = e.button;
    });
    // Scroll-driven remount (see _renderWindow): only the row/column range
    // currently in (or just outside) view has real DOM nodes, so scrolling
    // has to recompute that range and mount/unmount accordingly.
    // rAF-throttled in _onScroll so a fast scroll/fling (which can fire
    // many scroll events per frame on some platforms) recomputes at most
    // once per paint. Bound once here (like the document-level listeners
    // above), not in _build() -- this.container persists across rebuilds;
    // only this.table/this._tbody get replaced.
    this.container.addEventListener('scroll', () => this._onScroll());
    // A viewport resize (window resize -- e.g. a mobile orientation change,
    // or a layout change that grows/shrinks .grid-scroll itself) can
    // reveal more/less of the sheet with no scroll event firing at all --
    // recompute the window then too, so a newly-revealed edge isn't blank.
    window.addEventListener('resize', () => this._renderWindow());
    this._build();
  }

  _onContainerFocus() {
    // A right-click's mousedown can itself cause this focus event -- the
    // container is the nearest focusable ancestor of a row/col header
    // <th> (headers aren't focusable themselves), so a right-click on one
    // shifts focus here exactly like a left-click would. If nothing was
    // selected yet, the cascade below (_select -> _scrollRefIntoView) used
    // to run unconditionally between the header's mousedown and its
    // still-pending contextmenu event -- scrolling/remounting the sheet
    // out from under the pointer -- so _onContextMenu's hit-test (which
    // reads e.target/elementFromPoint at contextmenu-dispatch time) landed
    // on a completely different header than the one actually right-
    // clicked, and Insert/Delete then silently acted on the wrong row/
    // column. Skip the cascade entirely for a right-click: _onContextMenu
    // already resolves its own target straight from the real DOM element
    // under the pointer and doesn't need a pre-existing selection to do
    // that correctly, so there's nothing lost by not auto-selecting first.
    if (this._lastMouseDownButton === 2) return;
    if (this.selected) return;
    const ref = this._firstSelectableRef();
    if (ref) this._select(ref, false);
  }

  /** Toggle read-only after construction -- e.g. app.js's WS-session-level
   * "too many active editors" congestion demotion/promotion (see
   * ws-server/session.py), layered on top of (never loosening) whatever
   * this.readOnly was already set to for the user's actual DB-granted
   * access level. Updates the same .grid-readonly class _build() applies,
   * without forcing a full rebuild -- toggling it shouldn't blow away
   * selection/scroll position the way a structural change does. */
  setReadOnly(value) {
    this.readOnly = !!value;
    this._syncReadOnlyClass();
  }

  _syncReadOnlyClass() {
    this.container.className = 'grid-scroll' + (this.readOnly ? ' grid-readonly' : '');
  }

  /** First (top-left, reading order) cell not covered by another cell's merge -- normally just "A1". */
  _firstSelectableRef() {
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        const ref = colLetter(c) + (r + 1);
        if (!this._isCovered(ref)) return ref;
      }
    }
    return null;
  }

  // --- Remote state / patches --------------------------------------

  /** Full document replace (e.g. on initial WS "state" message or reload). */
  setDocument(doc) {
    // Captured before any mutation below so a CSV-import replace (or a WS
    // reconnect re-fetch) doesn't scroll the user back to the top of a
    // large sheet they were scrolled down in -- see _captureScrollAnchor's
    // doc comment for why this can't just be "leave scrollTop alone" under
    // windowing. No index remap needed on restore (unlike
    // _transformStructure): this is a wholesale replace, not a row/column
    // shift, so the same row/col index is still the right place to land.
    const scrollAnchor = this._captureScrollAnchor();
    doc = doc || {};
    this.cells = doc.cells || {};
    this.columnWidths = doc.columnWidths || {};
    this.rowHeights = doc.rowHeights || {};
    this.cols = doc.cols || LEGACY_COLS;
    this.rows = doc.rows || LEGACY_ROWS;
    this._build();
    this._restoreScrollAnchor(scrollAnchor);
  }

  /**
   * Apply a remote merge patch (from another collaborator) -- the same
   * full-document shape onChange emits, not a bare cell patch. A cell
   * patch whose value touches `merge` forces a structural rebuild (the
   * table's actual TD layout depends on which cells are merge-covered);
   * anything else updates in place.
   *
   * @param {object} patch
   * @param {Array<{dimension: 'row'|'col', boundaryIndex: number, count:
   *   number, isInsert: boolean}>} [structuralOps] -- riding alongside
   *   `patch` as a sibling on the WS message (see ws.js/ws-server's
   *   session.py -- never merged into `patch` itself, so it never touches
   *   the persisted document), present only when this patch came from one
   *   or more local _transformStructure() calls (insert/delete row/column)
   *   on the SENDING client. Used below to remap THIS viewer's own scroll
   *   anchor by the same boundaryIndex/count/isInsert the sender's local
   *   _transformStructure used on itself -- see the `structural` branch.
   */
  applyRemote(patch, structuralOps) {
    // Captured unconditionally, before anything below might mutate
    // this.cells/rows/cols -- cheap, and only actually used if this patch
    // turns out to force a structural rebuild (see the `structural` branch
    // at the bottom) -- a remote collaborator's insert/delete/merge must
    // not scroll every OTHER connected viewer back to the top of their own
    // scrolled-down view. If `structuralOps` is present (a remote
    // insert/delete), the captured rowIndex/colIndex is remapped by it
    // below, exactly like a local _transformStructure remaps its own
    // scrollAnchor -- otherwise (remote merge/unmerge, or any other
    // structural patch that doesn't renumber rows/columns) the plain
    // captured index is already correct, same as before.
    const scrollAnchor = this._captureScrollAnchor();
    let structural = false;
    let changedRefs = null;
    if (patch.cells) {
      changedRefs = Object.keys(patch.cells);
      for (const [ref, value] of Object.entries(patch.cells)) {
        if (value === null) {
          if (this.cells[ref] && this.cells[ref].merge) structural = true;
          delete this.cells[ref];
        } else {
          if (('merge' in value) || (this.cells[ref] && this.cells[ref].merge)) structural = true;
          this.cells[ref] = { ...(this.cells[ref] || {}), ...value };
        }
        // A remote patch touching a cell the local user is actively,
        // not-yet-committed editing must not blow away their open
        // <input class="cell-input"> (see BUGS_FOUND.md [016] -- the old
        // unconditional _renderCell() below did `el.innerHTML = ''`,
        // destroying the focused input, which fired a native blur that
        // force-committed the interrupted partial text over the remote
        // edit). this.cells above is still updated with the remote value,
        // so it's correct once editing ends -- via _commitEdit()'s own
        // _renderCell() call on blur/Enter (which then also overwrites with
        // whatever the user was actively typing, same last-write-wins
        // semantics as any other concurrent edit), or via Escape's explicit
        // _renderCell() call, which will correctly show this remote value.
        const isBeingEdited = this.editingInput && this.editingInput.ref === ref;
        if (!structural && !isBeingEdited) this._renderCell(ref);
      }
    }
    if (patch.columnWidths) {
      for (const [col, width] of Object.entries(patch.columnWidths)) {
        if (width === null) delete this.columnWidths[col];
        else this.columnWidths[col] = width;
      }
      this._applyColumnWidths();
    }
    if (patch.rowHeights) {
      for (const [row, height] of Object.entries(patch.rowHeights)) {
        if (height === null) delete this.rowHeights[row];
        else this.rowHeights[row] = height;
      }
      this._applyRowHeights();
    }
    // A remote width/height change alone (no structural cols/rows change --
    // that's the `structural` branch below, which already forces a full
    // _build()) can move the pixel boundaries the currently-rendered
    // window was computed from (see _computeVisibleWindow) -- e.g. a
    // spacer row/column's size was computed from the old rowHeights/
    // columnWidths and is now stale. Cheap to just recompute; avoids a
    // visible jump the next time this viewer scrolls.
    if ((patch.columnWidths || patch.rowHeights) && this.table) {
      this._lastWindow = null;
      this._renderWindow();
    }
    // A remote insert/delete row/column changes the grid's own dimensions
    // -- always a structural rebuild (the whole table layout depends on
    // cols/rows, not something _applyColumnWidths/_applyRowHeights's
    // narrower per-element updates can express).
    if (typeof patch.cols === 'number' && patch.cols !== this.cols) {
      this.cols = patch.cols;
      structural = true;
    }
    if (typeof patch.rows === 'number' && patch.rows !== this.rows) {
      this.rows = patch.rows;
      structural = true;
    }
    if (structural) {
      this._build();
      // Remap the captured anchor by every structural op included on this
      // patch (ordinarily exactly one -- see queueEdit/_flushEdit's doc
      // comment for the rare multi-op-before-flush case), same rule as
      // _transformStructure's own remapIndex. Absent/empty (merge/unmerge,
      // or a patch from a pre-this-fix sender) leaves rowIndex/colIndex
      // undefined, so _restoreScrollAnchor falls back to the plain
      // captured index, matching the previous (pre-fix) behavior.
      let newRowIndex, newColIndex;
      if (scrollAnchor && Array.isArray(structuralOps)) {
        newRowIndex = scrollAnchor.rowIndex;
        newColIndex = scrollAnchor.colIndex;
        for (const op of structuralOps) {
          if (!op) continue;
          if (op.dimension === 'row') {
            newRowIndex = this._remapStructuralIndex(newRowIndex, op.boundaryIndex, op.count, op.isInsert);
          } else if (op.dimension === 'col') {
            newColIndex = this._remapStructuralIndex(newColIndex, op.boundaryIndex, op.count, op.isInsert);
          }
        }
      }
      this._restoreScrollAnchor(scrollAnchor, newRowIndex, newColIndex);
    } else if (changedRefs) {
      // Structural changes already re-render every mounted cell via
      // _build()'s fresh _renderWindow() mount -- only the non-structural
      // path needs an explicit
      // dependents pass, so a formula cell watching one of these refs
      // (e.g. D1="=B1+C1" watching a remote edit to B1) updates for every
      // connected viewer, not just the one who made the edit.
      this._recalcDependents(changedRefs);
    }
  }

  // --- Build / render -------------------------------------------------

  _build() {
    const prevSelected = this.selected;
    const prevAnchor = this.anchor;
    this.container.innerHTML = '';
    // .grid-readonly (see app.css) drops the edit-affordance cursor --
    // cells stay selectable/copiable (Fernando: "Cells need to be
    // selectable and copiable, but not appear like they are editable"),
    // this is purely visual, the actual write-blocking is the readOnly
    // checks throughout this file. Set here (not just once externally)
    // since _build() re-runs and resets className on every structural
    // rebuild (merge/unmerge, remote patch, resize, insert/delete).
    this._syncReadOnlyClass();
    const table = document.createElement('table');
    table.className = 'grid';
    this.table = table;

    this._coverage = this._computeCoverage();

    // Cached element refs (col by index, row <tr> by index) so a live
    // resize drag can write directly to the one element that changed --
    // see _onResizeMove -- instead of re-touching every column/row on
    // every mousemove (that was the old behavior; see _applyColumnWidths'
    // doc comment for why it was a real perf/flicker bug, not just slow).
    this._colElements = [];
    this._colHeaderElements = [];
    const colgroup = document.createElement('colgroup');
    const rowHeaderCol = document.createElement('col');
    rowHeaderCol.style.width = ROW_HEADER_WIDTH + 'px';
    colgroup.appendChild(rowHeaderCol);
    for (let c = 0; c < this.cols; c++) {
      const col = document.createElement('col');
      col.style.width = (this.columnWidths[colLetter(c)] || DEFAULT_COL_WIDTH) + 'px';
      colgroup.appendChild(col);
      this._colElements.push(col);
    }
    table.appendChild(colgroup);
    this._syncTableWidth();

    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    const cornerTh = document.createElement('th');
    // The blank corner cell (no data-row-index/data-col-index -- it's a
    // hit-testing spacer, not a real row/column header, see
    // _resolveDragTarget's 'col'-case comment above) previously had no
    // click behavior at all. Clicking it now deselects any current
    // cell/range selection.
    cornerTh.addEventListener('click', () => this._deselectAll());
    headRow.appendChild(cornerTh);
    for (let c = 0; c < this.cols; c++) {
      const letter = colLetter(c);
      const th = document.createElement('th');
      th.textContent = letter;
      th.dataset.colIndex = String(c);
      // mousedown (not click) so drag-across-headers can extend a
      // multi-column selection the same way cell drag-select works --
      // see _onColHeaderMouseDown/_onMouseMoveDrag.
      th.addEventListener('mousedown', (e) => this._onColHeaderMouseDown(e, c));
      th.addEventListener('touchstart', (e) => this._onColHeaderTouchStart(e, c), { passive: true });
      th.appendChild(this._colResizeHandle(letter, this._colElements[c]));
      headRow.appendChild(th);
      this._colHeaderElements.push(th);
    }
    thead.appendChild(headRow);
    table.appendChild(thead);

    // Merge origins (cells with cell.merge), precomputed once per
    // structural rebuild -- _computeVisibleWindow() needs these on every
    // scroll-driven remount to guarantee a window boundary never lands in
    // the middle of a merge (see its own doc comment), and rescanning
    // this.cells for merges on every scroll tick would be needless
    // repeated work when the set of merges only ever changes on a
    // structural rebuild anyway.
    this._mergeOrigins = this._computeMergeOrigins();

    // Real <tr>/<td> nodes only ever exist for the currently-windowed
    // row/column range now (see _renderWindow) -- _cellElements/
    // _rowElements/_rowHeaderElements are (re)populated fresh by
    // _renderWindow on every remount, never populated directly here.
    // this._tbody is reset to null so the _renderWindow() call below
    // appends a fresh <tbody> to this new `table` rather than trying to
    // replace a <tbody> that belonged to the PREVIOUS (now-discarded)
    // table.
    this._rowElements = [];
    this._rowHeaderElements = [];
    this._cellElements = new Map();
    this._tbody = null;
    this.container.appendChild(table);

    // Selection is driven off mousedown/mousemove/mouseup (drag-to-select
    // a range), not a plain 'click' listener -- a click is just a
    // mousedown+mouseup with no movement in between, so this subsumes
    // single-cell selection too. This also lets us preventDefault() on
    // mousedown, which stops the browser's native text-selection/highlight
    // behavior that otherwise kicks in when dragging across table cells
    // (there's no actual DOM text selection API involved in our own
    // range-select, so nothing is lost by suppressing the native one).
    // table is a fresh element every _build() call, so its own listeners
    // DO need re-attaching each time (unlike the document-level ones bound
    // once in the constructor above).
    table.addEventListener('mousedown', (e) => this._onMouseDown(e));
    table.addEventListener('mousemove', (e) => this._onMouseMoveDrag(e));
    table.addEventListener('dblclick', (e) => this._onCellDblClick(e));
    // Touch counterpart of the mouse drag-select above -- see _onTouchStart's
    // doc comment for why this needs a long-press arm rather than just
    // mirroring mousedown/mousemove directly.
    table.addEventListener('touchstart', (e) => this._onTouchStart(e), { passive: true });
    table.addEventListener('touchmove', (e) => this._onTouchMove(e), { passive: false });

    // Force a fresh window computation -- rows/cols, coverage, and merge
    // origins may all have just changed, so any window computed before
    // this rebuild (if any) can't be trusted. This mounts the tbody and
    // renders its cells' content (see _renderWindow).
    this._lastWindow = null;
    this._renderWindow();

    // Restore selection across a structural rebuild (merge/unmerge, remote
    // merge patch, resize) so the user doesn't lose their place -- restored
    // from STATE (prevSelected/prevAnchor captured before this.cells/
    // this.rows/this.cols above could have changed), not from whether the
    // previously-selected ref currently has a live DOM node. Under
    // windowing, a selected cell the user has since scrolled away from is
    // routinely off-screen (no live node) at the moment some OTHER
    // collaborator's structural change rebuilds this table -- that must
    // not silently drop the local selection just because it's not
    // currently mounted. _refInBounds/_isCovered below still guard against
    // restoring a ref a structural change (e.g. a remote column delete)
    // actually removed from the grid entirely; _highlightRange/_cellEl
    // already tolerate a ref with no live node either way.
    if (prevSelected && this._refInBounds(prevSelected) && !this._isCovered(prevSelected)) {
      this.anchor = (prevAnchor && this._refInBounds(prevAnchor) && !this._isCovered(prevAnchor))
        ? prevAnchor : prevSelected;
      this.selected = prevSelected;
      this._highlightRange(this.anchor, this.selected);
    }

    if (this.onRebuild) this.onRebuild();
  }

  /** ref -> true for every cell covered by another cell's merge (i.e. not the origin). */
  _computeCoverage() {
    const covered = new Set();
    for (const [ref, cell] of Object.entries(this.cells)) {
      if (!cell || !cell.merge) continue;
      const { row, col } = parseRef(ref);
      for (let dr = 0; dr < cell.merge.rows; dr++) {
        for (let dc = 0; dc < cell.merge.cols; dc++) {
          if (dr === 0 && dc === 0) continue;
          covered.add(colLetter(col + dc) + (row + dr + 1));
        }
      }
    }
    return covered;
  }

  _isCovered(ref) {
    return this._coverage.has(ref);
  }

  _colResizeHandle(letter, colEl) {
    const handle = document.createElement('span');
    handle.className = 'col-resize-handle';
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const startSize = this.columnWidths[letter] || DEFAULT_COL_WIDTH;
      this._resizing = {
        kind: 'col', key: letter, startPx: e.clientX,
        startSize,
        el: colEl,
        // Table width excluding the column being dragged, captured once
        // at drag start -- _onResizeMove just adds the live size back to
        // this fixed base on every move (O(1), no accumulation/drift
        // risk across however many mousemoves the drag produces).
        baseTableWidth: this._sumColumnWidths() - startSize,
      };
    });
    return handle;
  }

  _rowResizeHandle(rowNum, rowEl) {
    const handle = document.createElement('span');
    handle.className = 'row-resize-handle';
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this._resizing = {
        kind: 'row', key: rowNum, startPx: e.clientY,
        startSize: this.rowHeights[rowNum] || DEFAULT_ROW_HEIGHT,
        el: rowEl,
      };
    });
    return handle;
  }

  _onResizeMove(e) {
    if (!this._resizing) return;
    const { kind, startPx, startSize, el } = this._resizing;
    if (kind === 'col') {
      const size = Math.max(MIN_COL_WIDTH, startSize + (e.clientX - startPx));
      this._resizing.liveSize = size;
      // Write directly to the one <col> being dragged -- not
      // _applyColumnWidths(), which used to loop over every column on
      // every mousemove (see its doc comment). A <col> width write
      // already forces the browser to recompute the whole table's
      // column layout once; doing that redundantly for N-1 unchanged
      // columns on every mousemove was the actual cost, not the resize
      // itself, and was very likely what read as "affects other
      // columns" too -- the stored data was never wrong (_onResizeEnd
      // only ever commits this one key), just the rendering was
      // thrashing under that load.
      if (el) el.style.width = size + 'px';
      // The table's own width has to track the live size too, not just
      // the one <col> -- with table-layout:fixed (see app.css), a table
      // with no explicit width falls back to fitting the space actually
      // available in .grid-scroll, which reintroduces the exact
      // "squeezes the other columns" bug this whole fix targets.
      // baseTableWidth (sum of every OTHER column, fixed at drag start)
      // + this column's current live size -- O(1) per mousemove, and
      // exact regardless of move count since it's recomputed from a
      // fixed base each time, never accumulated.
      if (this.table) this.table.style.width = (this._resizing.baseTableWidth + size) + 'px';
    } else {
      const size = Math.max(MIN_ROW_HEIGHT, startSize + (e.clientY - startPx));
      this._resizing.liveSize = size;
      if (el) {
        el.style.height = size + 'px';
        this._syncRowCellHeights(el, size); // el is the <tr> here -- keep its cells' clipping height live during the drag too
      }
    }
  }

  _onResizeEnd() {
    if (!this._resizing) return;
    const { kind, key, liveSize } = this._resizing;
    this._resizing = null;
    if (liveSize === undefined) return; // mousedown with no movement -- not a real resize
    if (kind === 'col') {
      this.columnWidths[key] = liveSize;
      this.onChange({ columnWidths: { [key]: liveSize } });
    } else {
      this.rowHeights[key] = liveSize;
      this.onChange({ rowHeights: { [key]: liveSize } });
    }
  }

  /**
   * Full re-sync of every column's width from this.columnWidths. Used
   * after a remote patch touches (possibly several) column widths at
   * once -- see applyRemote. NOT used for a live local drag; that writes
   * straight to the one dragged element (_onResizeMove) instead of
   * looping over every column here on every mousemove, which is what
   * used to make column resizing noticeably slower than row resizing
   * (touching a <col>'s width forces a whole-table column-layout
   * recompute, so doing it once per unchanged column per mousemove was
   * real, measurable waste, not just untidy code) and was the likely
   * cause of other columns visibly flickering during a drag even though
   * their stored widths were never actually touched.
   */
  _applyColumnWidths() {
    if (!this._colElements) return;
    for (let c = 0; c < this.cols; c++) {
      const width = this.columnWidths[colLetter(c)] || DEFAULT_COL_WIDTH;
      if (this._colElements[c]) this._colElements[c].style.width = width + 'px';
    }
    this._syncTableWidth();
  }

  _sumColumnWidths() {
    let total = ROW_HEADER_WIDTH;
    for (let c = 0; c < this.cols; c++) total += this.columnWidths[colLetter(c)] || DEFAULT_COL_WIDTH;
    return total;
  }

  /**
   * Keeps the <table>'s own width equal to the sum of its columns' widths
   * -- required alongside table-layout:fixed (see app.css) so the table
   * can legitimately be wider than .grid-scroll and scroll horizontally,
   * instead of being squeezed to fit it. Called after any full
   * column-width re-sync (initial _build, remote patches via
   * _applyColumnWidths); the live local-drag path in _onResizeMove
   * updates this.table.style.width directly and cheaper, it doesn't call
   * this.
   */
  _syncTableWidth() {
    if (this.table) this.table.style.width = this._sumColumnWidths() + 'px';
  }

  /** Row-height counterpart of _applyColumnWidths -- same reasoning, see its doc comment. */
  _applyRowHeights() {
    if (!this._rowElements) return;
    for (let r = 0; r < this.rows; r++) {
      const rowNum = r + 1;
      const height = this.rowHeights[rowNum] || DEFAULT_ROW_HEIGHT;
      const tr = this._rowElements[r];
      if (!tr) continue;
      tr.style.height = height + 'px';
      this._syncRowCellHeights(tr, height);
    }
  }

  /**
   * Sets height+overflow:hidden on every direct cell of a row (skipping
   * a rowSpan>1 origin cell, whose natural height should be the sum of
   * the rows it spans, not this one) -- see the doc comment in _build()
   * for why this needs to happen per-cell, not just on the <tr>.
   */
  _syncRowCellHeights(tr, height) {
    for (const cell of tr.children) {
      if (cell.rowSpan > 1) continue;
      cell.style.height = height + 'px';
      cell.style.overflow = 'hidden';
    }
  }

  /**
   * The live <td> for `ref`, or null if it currently has none -- either
   * because it's merge-covered (never has its own node, see _isCovered),
   * or because it's outside the currently-rendered window (see
   * _renderWindow/_computeVisibleWindow) and simply isn't mounted right
   * now. `this.cells[ref]` (the actual data) is unaffected either way --
   * a scrolled-off cell's value/format/merge is exactly as real as a
   * currently-visible one, it just has no DOM node backing it at this
   * moment. Every caller that reaches into a <td> via this or via
   * `td.dataset.ref`/`closest('td')` directly has to treat a null/missing
   * result as "not currently on screen," not "doesn't exist."
   */
  _cellEl(ref) {
    return this._cellElements.get(ref) || null;
  }

  /**
   * Whether keyboard shortcuts (arrows, Delete, Ctrl+C/V, etc.) should
   * defer to some other on-page control instead of acting on the grid.
   * Cells aren't focusable (td.tabIndex = -1, never explicitly focused),
   * so document.activeElement after selecting a cell is normally
   * document.body -- but it becomes whatever the user last focused
   * (a toolbar button, a dialog's username field, ...) once they've
   * interacted with anything else, without that meaning they're done
   * with the grid. Only actually defer when focus is in something that
   * itself wants keyboard input -- a real input/textarea/contenteditable
   * outside the grid -- not merely "not literally body".
   */
  _keyboardShouldDeferToOtherControl() {
    const active = document.activeElement;
    if (!active || active === document.body || this.container.contains(active)) return false;
    return active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable;
  }

  /**
   * A dialog like the formula-help modal has no focusable input at all
   * (nothing to type into), so _keyboardShouldDeferToOtherControl() above
   * -- which only catches an INPUT/TEXTAREA/contentEditable actually
   * stealing focus -- doesn't defer for it: document.activeElement stays
   * whatever it was before the dialog opened. Without this, Delete/
   * Backspace/Ctrl+C etc. fired at a modal (e.g. while selecting its text
   * to copy) fall through to the grid underneath instead of being ignored.
   */
  _isModalOpen() {
    return !!document.querySelector('.modal');
  }

  /**
   * Real, non-collapsed browser text selection that isn't entirely inside
   * the grid's own container -- table.grid has user-select:none (see
   * app.css), so a genuine selection outside it can only mean the user is
   * trying to copy something else on the page (a modal's text, most
   * likely). _isModalOpen() above already covers that same case more
   * simply, but this also protects a future non-modal selectable region,
   * and is the more semantically precise check specifically for copy.
   */
  _hasExternalTextSelection() {
    const sel = window.getSelection && window.getSelection();
    if (!sel || sel.isCollapsed || !sel.anchorNode) return false;
    return !this.container.contains(sel.anchorNode) || !this.container.contains(sel.focusNode);
  }

  /**
   * Renders cell CONTENT for exactly the given refs (an iterable of ref
   * strings) -- called with "every ref newly mounted by the last
   * _renderWindow() call" (see there and _reconcileWindow's doc comment),
   * NOT every currently-mounted ref -- that was this method's older,
   * destroy-and-recreate-everything-every-time behavior (see BUGS_FOUND.md
   * [021]/[024]'s original write-up, and this commit's own perf write-up for
   * why that destroy/recreate approach, while bounded and fine in isolation,
   * turned out to make real integrated scroll performance WORSE than
   * pre-virtualization master, not better).
   *
   * Under the recycling renderer, a ref that was already mounted before this
   * remount and STAYS mounted keeps whatever content its <td> already has --
   * nothing about its underlying data could have changed purely from a
   * scroll. Every OTHER place cell data actually changes (setCellValue,
   * applyRemote's non-structural branch, _recalcDependents) already calls
   * _renderCell(ref) directly and immediately for a ref that's mounted at
   * the time of the change; for one that's unmounted at that moment, the
   * data (this.cells) is still updated correctly, and the fresh value is
   * picked up for free the next time this method is called with that ref --
   * i.e. exactly when it next becomes newly mounted, here.
   */
  _renderNewlyMountedRefs(refs) {
    for (const ref of refs) {
      if (!this._isCovered(ref)) this._renderCell(ref);
    }
  }

  /** List of {ref, row, col, rows, cols} for every merge origin currently
   * on the sheet -- see _computeVisibleWindow's doc comment for why this
   * is precomputed once per structural rebuild (_build()) rather than
   * rescanned on every scroll tick. */
  _computeMergeOrigins() {
    const origins = [];
    for (const [ref, cell] of Object.entries(this.cells)) {
      if (!cell || !cell.merge) continue;
      const { row, col } = parseRef(ref);
      origins.push({ ref, row, col, rows: cell.merge.rows, cols: cell.merge.cols });
    }
    return origins;
  }

  /** Whether `ref` is still a real position in the current
   * this.rows x this.cols grid -- used when restoring selection across a
   * structural rebuild (a remote column/row delete can leave a
   * previously-valid ref out of bounds), independent of whether it
   * currently has a live DOM node (see _build()'s selection-restore
   * comment). */
  _refInBounds(ref) {
    const p = parseRef(ref);
    return p.col >= 0 && p.col < this.cols && p.row >= 0 && p.row < this.rows;
  }

  /** Cumulative pixel offsets: index i -> the top of row i (0-indexed),
   * index `this.rows` -> total table height. Recomputed fresh on every
   * call rather than cached -- O(rows), trivial next to the cost of
   * actually creating/destroying DOM nodes, and this avoids having to
   * remember to invalidate a cache at every one of the several places
   * rowHeights can change (live resize drag, remote patch, structural
   * transform). */
  _rowTops() {
    const tops = [0];
    for (let r = 0; r < this.rows; r++) {
      tops.push(tops[r] + (this.rowHeights[r + 1] || DEFAULT_ROW_HEIGHT));
    }
    return tops;
  }

  /** Column counterpart of _rowTops -- cumulative left offsets. */
  _colLefts() {
    const lefts = [0];
    for (let c = 0; c < this.cols; c++) {
      lefts.push(lefts[c] + (this.columnWidths[colLetter(c)] || DEFAULT_COL_WIDTH));
    }
    return lefts;
  }

  /**
   * Captures enough about the current scroll position to restore it after
   * a structural rebuild (_build(), via mergeSelection/unmergeSelection/
   * _transformStructure/applyRemote/setDocument -- see each call site) --
   * not just the raw scrollTop/scrollLeft pixel values, but the actual
   * row/column INDEX currently at the top-left of the viewport plus the
   * exact sub-row/sub-col pixel offset within it.
   *
   * The raw pixel values alone aren't enough to restore from, and can't
   * just be reapplied unchanged after _build() runs: _build() clears
   * this.container's content (`innerHTML = ''`) and rebuilds it piece by
   * piece, and _renderWindow() (called partway through, before the tbody
   * has its full-height spacer rows back) reads this.container.scrollTop/
   * scrollLeft to compute the window -- at that moment the container is
   * still nearly empty (just the new, empty colgroup/thead), so the
   * browser has already clamped scrollTop/scrollLeft down to fit that
   * tiny transient scrollable range, and that clamp sticks even once the
   * full-height content is back (confirmed via real-Chromium measurement:
   * this is exactly why a scrolled-down sheet snapped to the top on every
   * insert/delete/merge/CSV-import/remote-structural-patch under
   * virtualization, when pre-virtualization code -- which never reads
   * scrollTop mid-rebuild -- preserved it for free).
   *
   * Capturing the logical row/col index (not just raw pixels) also lets a
   * caller that's about to renumber rows/columns (_transformStructure)
   * remap that index to account for the shift before restoring -- see
   * _restoreScrollAnchor's rowIndex/colIndex params -- so a user scrolled
   * past an inserted/deleted boundary stays looking at the same actual
   * content, not just the same raw pixel offset (which would now be
   * showing different rows/columns entirely).
   *
   * Call this BEFORE mutating this.rows/this.cols/this.rowHeights/
   * this.columnWidths -- it uses their current (pre-mutation) values.
   */
  _captureScrollAnchor() {
    if (!this.container) return null;
    const rowTops = this._rowTops();
    const colLefts = this._colLefts();
    const scrollTop = this.container.scrollTop;
    const scrollLeft = this.container.scrollLeft;
    const rowIndex = this._findOffsetIndex(rowTops, scrollTop, this.rows);
    const colIndex = this._findOffsetIndex(colLefts, scrollLeft, this.cols);
    return {
      rowIndex, colIndex,
      rowOffsetPx: scrollTop - rowTops[rowIndex],
      colOffsetPx: scrollLeft - colLefts[colIndex],
    };
  }

  /**
   * Restores a scroll anchor captured by _captureScrollAnchor() above --
   * call once _build() has finished (so the container's full scrollable
   * size is back and a scrollTop/scrollLeft write here actually sticks,
   * rather than being immediately clamped away again). `rowIndex`/
   * `colIndex` override the anchor's own captured index -- pass the
   * REMAPPED index (see _transformStructure) when a row/column insert or
   * delete has shifted things around since capture; omit (or pass the
   * same value) when nothing renumbered (merge/unmerge, a fresh
   * setDocument/CSV replace, a remote structural patch) and the plain
   * captured index is already correct. A no-op if nothing was captured
   * (e.g. no container yet).
   */
  _restoreScrollAnchor(anchor, rowIndex, colIndex) {
    if (!anchor || !this.container) return;
    const row = Math.min(this.rows - 1, Math.max(0, rowIndex !== undefined ? rowIndex : anchor.rowIndex));
    const col = Math.min(this.cols - 1, Math.max(0, colIndex !== undefined ? colIndex : anchor.colIndex));
    const rowTops = this._rowTops();
    const colLefts = this._colLefts();
    this.container.scrollTop = Math.max(0, rowTops[row] + anchor.rowOffsetPx);
    this.container.scrollLeft = Math.max(0, colLefts[col] + anchor.colOffsetPx);
    this._renderWindow();
  }

  /**
   * Maps a pre-shift row/col index to its post-shift equivalent for a
   * single insert/delete at `boundaryIndex` (count `count`) -- shared by
   * _transformStructure (remapping the LOCAL editor's own scroll anchor)
   * and applyRemote's structural branch (remapping every OTHER connected
   * viewer's scroll anchor for a REMOTE insert/delete -- see applyRemote's
   * doc comment for how the boundaryIndex/count/isInsert triple gets from
   * the sender to here over the wire). Insert: shift by `count` if at/after
   * the boundary. Delete: shift back by `count` if entirely past the
   * deleted range, or clamp to the boundary itself if it fell inside the
   * deleted range (whatever now occupies that position).
   */
  _remapStructuralIndex(idx, boundaryIndex, count, isInsert) {
    if (isInsert) return idx >= boundaryIndex ? idx + count : idx;
    if (idx >= boundaryIndex + count) return idx - count;
    if (idx >= boundaryIndex) return boundaryIndex;
    return idx;
  }

  /**
   * Scrolls the container just enough (minimal adjustment, never more than
   * needed -- not "center it") to bring `ref` fully into view, if it isn't
   * already -- e.g. arrow-key traversal (_moveSelection, via _select) or a
   * whole-row/column header selection landing outside the currently
   * visible viewport. A merge origin's full span (not just its 1x1 top-
   * left position) is what has to become visible -- a merge covering rows
   * 5-7 isn't "in view" if only row 5 is. No-ops (and so never forces a
   * render) if the ref is already fully visible, so normal same-window
   * selection changes (the overwhelming majority) never touch scrollTop/
   * scrollLeft or trigger an extra _renderWindow() call.
   */
  _scrollRefIntoView(ref) {
    if (!this.container || !this._refInBounds(ref)) return;
    const p = parseRef(ref);
    const cell = this.cells[ref];
    const merge = cell && cell.merge;
    const rowSpan = (merge && merge.rows) || 1;
    const colSpan = (merge && merge.cols) || 1;
    this._scrollRowIntoView(p.row, rowSpan);
    this._scrollColIntoView(p.col, colSpan);
  }

  /**
   * Row counterpart used directly by _scrollRefIntoView above and by
   * selectWholeRow (whose "selected" ref is the far edge column, not
   * useful for deciding vertical scroll position -- the row index itself
   * is what matters there). `span` covers a rowSpan>1 merge origin.
   *
   * This is a two-pass scroll: an initial estimate from the LOGICAL model
   * (_rowTops(), built from rowHeights) gets the target row mounted (all
   * _computeVisibleWindow's buffer needs to guarantee that), followed by
   * _correctRowScrollForRealHeight's exact correction using the row's REAL
   * rendered position once it exists -- see that method's doc comment for
   * why the logical estimate alone isn't precise enough on its own.
   */
  _scrollRowIntoView(row, span = 1) {
    if (!this.container) return;
    const rowTops = this._rowTops();
    const top = rowTops[row];
    const bottom = rowTops[Math.min(this.rows, row + span)];
    const viewTop = this.container.scrollTop;
    const viewH = this.container.clientHeight;
    let next = null;
    if (top < viewTop) next = top;
    else if (bottom > viewTop + viewH) next = Math.max(0, bottom - viewH);
    if (next !== null && next !== viewTop) {
      this.container.scrollTop = next;
      // Recompute/remount immediately rather than waiting for the
      // container's own async 'scroll' event + rAF throttle (_onScroll) --
      // the caller (selection change) needs the newly-selected ref's <td>
      // to exist right away (e.g. _highlightRange/_beginEdit run right
      // after). _renderWindow() itself no-ops if this didn't actually
      // change the windowed range, so this never causes extra churn beyond
      // what the scroll already required.
      this._renderWindow();
    }
    this._correctRowScrollForRealHeight(row, span);
  }

  /**
   * _rowTops()'s cumulative offsets are built from rowHeights -- the
   * CONTENT height a row's cell-content wrapper is explicitly clipped to
   * (see _renderCell's own doc comment on why that's a separate div from
   * the <td> itself), not the actual on-screen height of the rendered
   * <tr>, which is a few px taller (table.grid td/th's own padding+border,
   * see app.css) since a <tr>'s CSS height is only ever a floor under
   * table layout, never a ceiling. That gap is invisible anywhere else in
   * this file (nothing before virtualization ever computed a pixel
   * position from rowHeights and compared it against a real scrollTop),
   * but _scrollRowIntoView's logical-estimate pass above is exactly that
   * computation -- confirmed via real-Chromium measurement to drift by
   * multiple rows' worth of px once dozens of rows are mounted at once
   * (real per-row height minus logical, times however many real rows sit
   * between the viewport's edge and the target row), enough to leave the
   * "scrolled into view" row actually just outside the viewport.
   *
   * Also accounts for the sticky <thead> (table.grid thead th { top: 0 },
   * see app.css): a row whose top is geometrically within the container's
   * own bounding box can still be entirely covered by the pinned header if
   * it sits in that reserved band -- the logical model has no notion of
   * this either.
   *
   * This runs AFTER the logical-estimate scroll has had a chance to mount
   * the target row (that's the only reason the estimate pass exists at
   * all -- _computeVisibleWindow can't mount a row it doesn't know to
   * consider), then measures the row's real getBoundingClientRect() and
   * nudges scrollTop by the exact remaining pixel delta, if any. A no-op
   * if the row still isn't mounted (e.g. genuinely out of bounds) or is
   * already fully visible.
   */
  _correctRowScrollForRealHeight(row, span = 1) {
    if (!this.container || !this.table) return;
    const startEl = this._rowElements[row];
    const endEl = this._rowElements[Math.min(this.rows, row + span) - 1] || startEl;
    if (!startEl || !endEl) return;
    const containerRect = this.container.getBoundingClientRect();
    const thead = this.table.querySelector('thead');
    const stickyTop = containerRect.top + (thead ? thead.getBoundingClientRect().height : 0);
    const startRect = startEl.getBoundingClientRect();
    const endRect = endEl.getBoundingClientRect();
    let delta = 0;
    if (startRect.top < stickyTop) delta = startRect.top - stickyTop;
    else if (endRect.bottom > containerRect.bottom) delta = endRect.bottom - containerRect.bottom;
    if (delta) {
      this.container.scrollTop = Math.max(0, this.container.scrollTop + delta);
      this._renderWindow();
    }
  }

  /** Column counterpart of _scrollRowIntoView -- see there for the overall
   * two-pass shape. Columns don't suffer _scrollRowIntoView's real-vs-
   * logical height drift (table-layout:fixed, see app.css, makes a
   * <col>'s specified width authoritative, unlike a <tr>'s height, which
   * is only ever a floor) -- but the sticky row-header column (table.grid
   * tbody th { left: 0 }) has the exact same "geometrically inside the
   * container, but actually covered by a pinned element" problem the
   * sticky thead has for rows, so this still needs its own correction
   * pass for that (_correctColScrollForStickyHeader). */
  _scrollColIntoView(col, span = 1) {
    if (!this.container) return;
    const colLefts = this._colLefts();
    const left = colLefts[col];
    const right = colLefts[Math.min(this.cols, col + span)];
    const viewLeft = this.container.scrollLeft;
    const viewW = this.container.clientWidth;
    let next = null;
    if (left < viewLeft) next = left;
    else if (right > viewLeft + viewW) next = Math.max(0, right - viewW);
    if (next !== null && next !== viewLeft) {
      this.container.scrollLeft = next;
      this._renderWindow();
    }
    this._correctColScrollForStickyHeader(col, span);
  }

  /** Sticky-row-header-column counterpart of _correctRowScrollForRealHeight
   * -- see there. Column headers (thead th) are never windowed (see
   * _build()), so `this._colHeaderElements[col]` is always a real,
   * correctly-positioned element regardless of scroll -- no need to wait
   * for a remount the way the row version does. */
  _correctColScrollForStickyHeader(col, span = 1) {
    if (!this.container || !this.table) return;
    const startTh = this._colHeaderElements[col];
    const endTh = this._colHeaderElements[Math.min(this.cols, col + span) - 1] || startTh;
    if (!startTh || !endTh) return;
    const containerRect = this.container.getBoundingClientRect();
    const rowHeaderTh = this.table.querySelector('tbody th') || this.table.querySelector('thead th');
    const stickyLeftWidth = rowHeaderTh ? rowHeaderTh.getBoundingClientRect().width : ROW_HEADER_WIDTH;
    const stickyLeft = containerRect.left + stickyLeftWidth;
    const startRect = startTh.getBoundingClientRect();
    const endRect = endTh.getBoundingClientRect();
    let delta = 0;
    if (startRect.left < stickyLeft) delta = startRect.left - stickyLeft;
    else if (endRect.right > containerRect.right) delta = endRect.right - containerRect.right;
    if (delta) {
      this.container.scrollLeft = Math.max(0, this.container.scrollLeft + delta);
      this._renderWindow();
    }
  }

  /** Largest index i (0 <= i < count) such that offsets[i] <= x -- i.e. the
   * row/column whose pixel range contains position x. `offsets` is one of
   * _rowTops()/_colLefts()'s arrays (length count+1, strictly
   * non-decreasing). Binary search since a large sheet's row/column count
   * can run into the thousands and this runs on every scroll-driven
   * recompute. */
  _findOffsetIndex(offsets, x, count) {
    if (count <= 0) return 0;
    if (x <= 0) return 0;
    if (offsets[count] <= x) return count - 1;
    let lo = 0, hi = count - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (offsets[mid] <= x) lo = mid; else hi = mid - 1;
    }
    return lo;
  }

  /**
   * Computes which row/column range should currently have real DOM nodes:
   * the range actually visible in the scroll container, plus a buffer on
   * every edge (a fraction of the viewport itself, floored at
   * MIN_ROW_BUFFER_PX/MIN_COL_BUFFER_PX -- see those constants' doc
   * comment) so a scroll doesn't outrun the rendered window and flash
   * blank space before the next remount catches up.
   *
   * Then expands that range so it never lands in the middle of a merge
   * (Fernando's requirement: a merge spanning rows 5-7 must not have row 6
   * windowed independently of 5 and 7) -- any merge that overlaps the
   * window AT ALL gets fully included, not just merges that straddle the
   * exact edge, which is simpler and strictly safer. Iterates to a fixed
   * point (capped at _mergeOrigins.length+1 passes, always enough --
   * each pass that changes anything strictly grows the range to include
   * at least one more not-yet-included merge) since including one merge
   * can newly overlap another (chained/adjacent merges) -- cheap
   * regardless, since _mergeOrigins is only ever as long as the sheet's
   * actual merge count, never its total cell count.
   */
  _computeVisibleWindow() {
    const rowTops = this._rowTops();
    const colLefts = this._colLefts();
    const viewportH = this.container.clientHeight || 800;
    const viewportW = this.container.clientWidth || 1200;
    const scrollTop = this.container.scrollTop;
    const scrollLeft = this.container.scrollLeft;
    const rowBufferPx = Math.max(MIN_ROW_BUFFER_PX, viewportH * BUFFER_VIEWPORT_FRACTION);
    const colBufferPx = Math.max(MIN_COL_BUFFER_PX, viewportW * BUFFER_VIEWPORT_FRACTION);

    let rowStart = this._findOffsetIndex(rowTops, scrollTop - rowBufferPx, this.rows);
    let rowEnd = this._findOffsetIndex(rowTops, scrollTop + viewportH + rowBufferPx, this.rows);
    let colStart = this._findOffsetIndex(colLefts, scrollLeft - colBufferPx, this.cols);
    let colEnd = this._findOffsetIndex(colLefts, scrollLeft + viewportW + colBufferPx, this.cols);

    for (let pass = 0; pass < this._mergeOrigins.length + 1; pass++) {
      let changed = false;
      for (const m of this._mergeOrigins) {
        const mRowEnd = m.row + m.rows - 1;
        const mColEnd = m.col + m.cols - 1;
        if (m.row <= rowEnd && mRowEnd >= rowStart) {
          if (m.row < rowStart) { rowStart = m.row; changed = true; }
          if (mRowEnd > rowEnd) { rowEnd = mRowEnd; changed = true; }
        }
        if (m.col <= colEnd && mColEnd >= colStart) {
          if (m.col < colStart) { colStart = m.col; changed = true; }
          if (mColEnd > colEnd) { colEnd = mColEnd; changed = true; }
        }
      }
      if (!changed) break;
    }

    // Snap outward to chunk boundaries (see ROW_CHUNK/COL_CHUNK's doc
    // comment) -- purely to cut how often the window actually changes
    // during a continuous scroll, not a correctness requirement.
    rowStart = Math.floor(rowStart / ROW_CHUNK) * ROW_CHUNK;
    rowEnd = Math.min(this.rows - 1, Math.ceil((rowEnd + 1) / ROW_CHUNK) * ROW_CHUNK - 1);
    colStart = Math.floor(colStart / COL_CHUNK) * COL_CHUNK;
    colEnd = Math.min(this.cols - 1, Math.ceil((colEnd + 1) / COL_CHUNK) * COL_CHUNK - 1);

    return { rowStart, rowEnd, colStart, colEnd, rowTops, colLefts };
  }

  /**
   * Mounts real <tr>/<td> nodes for the current visible+buffer window (see
   * _computeVisibleWindow) and nothing else -- the core of the
   * virtualization foundation. Called on initial build, on every
   * structural rebuild (_build() forces this via this._lastWindow = null),
   * and on every scroll/resize (_onScroll, the window 'resize' listener).
   *
   * RECYCLES existing <tr>/<td> nodes across a scroll-driven remount rather
   * than destroying and rebuilding the whole windowed <tbody> every time
   * (see _reconcileWindow) -- a row/column that's already mounted and stays
   * in the new window just gets repositioned/left alone; only a row/column
   * actually entering the window gets a genuinely new node, and only one
   * actually leaving gets removed. An earlier version of this method did
   * destroy-and-recreate the whole window every call, reasoning that a
   * rAF-throttled, window-bounded rebuild would be cheap regardless of
   * total sheet size -- true in an isolated micro-benchmark (no real CSS/
   * formatting/style-recalc cost), but confirmed via real-Chromium
   * measurement against the actual integrated app (220x52 sheet, real
   * app.css) to make real scroll performance measurably WORSE than
   * pre-virtualization master, not better -- the node-churn/style-recalc
   * cost of genuinely new elements on every single scroll tick outweighed
   * the "bounded, not O(sheet size)" argument. Recycling fixes that while
   * keeping every win the destroy/recreate version had: DOM node count
   * still bounded by the window (not sheet) size, cold load still only
   * mounts one window's worth of nodes, and the window/merge-boundary
   * computation itself (_computeVisibleWindow) is untouched.
   *
   * Falls back to a full (re)mount (_mountWindowFull) -- functionally
   * identical to the old destroy/recreate behavior -- whenever there's no
   * valid previous window to reconcile FROM (this._tbody is null, e.g.
   * right after _build() reset it, or this._lastWindow was explicitly
   * nulled, e.g. applyRemote's columnWidths/rowHeights branch forcing a
   * fresh layout after pixel offsets changed). That's the correct
   * fallback, not just a convenient one: reconciliation assumes
   * this._rowElements/_cellElements/tr._leftSpacer etc. already correctly
   * reflect a previously-mounted window, which isn't true the first time a
   * table exists.
   *
   * A no-op if the computed window is identical to the last one rendered
   * (e.g. a sub-pixel/no-op scroll event, or a resize that didn't actually
   * change the visible range) -- avoids needless DOM work on every single
   * scroll event even before the rAF throttle in _onScroll kicks in.
   */
  _renderWindow() {
    if (!this.table) return;
    const win = this._computeVisibleWindow();
    const prevWindow = this._lastWindow;
    if (prevWindow
      && prevWindow.rowStart === win.rowStart && prevWindow.rowEnd === win.rowEnd
      && prevWindow.colStart === win.colStart && prevWindow.colEnd === win.colEnd) {
      return;
    }
    this._lastWindow = { rowStart: win.rowStart, rowEnd: win.rowEnd, colStart: win.colStart, colEnd: win.colEnd };

    let newlyMountedRefs;
    if (!this._tbody || !prevWindow) {
      this._mountWindowFull(win);
      newlyMountedRefs = this._cellElements.keys();
    } else {
      newlyMountedRefs = this._reconcileWindow(prevWindow, win);
    }

    // A live row-resize drag (_onResizeMove/_resizing) holds a direct
    // reference to the <tr> it's dragging -- if a scroll-driven remount
    // just dropped that row from the window (recycling removes/re-creates
    // individual rows, so this can still happen even though most rows
    // survive a remount untouched now), the drag's `el` is a detached,
    // orphaned node: further live-height writes during the drag would
    // silently apply to nothing visible. Rebind to the freshly-mounted
    // <tr> for the same row (if it's still in the window, whether recycled
    // or newly created) and reapply whatever live size the drag was
    // already showing, so the resize continues seamlessly instead of
    // visually freezing. If the row scrolled fully out of the new window,
    // there's genuinely no handle for it any more -- `el` stays stale, but
    // _onResizeEnd still commits the correct final size from `key`/
    // `liveSize` regardless of DOM state, so the actual data-level result
    // is unaffected either way.
    if (this._resizing && this._resizing.kind === 'row') {
      const idx = Number(this._resizing.key) - 1;
      const newEl = this._rowElements[idx];
      if (newEl) {
        this._resizing.el = newEl;
        const liveSize = this._resizing.liveSize !== undefined ? this._resizing.liveSize : this._resizing.startSize;
        newEl.style.height = liveSize + 'px';
        this._syncRowCellHeights(newEl, liveSize);
      }
    }

    // Fill in content only for cells that are actually new to the DOM this
    // pass -- see _renderNewlyMountedRefs's doc comment for why a recycled,
    // still-mounted cell doesn't need (and must NOT get, to preserve the
    // whole point of recycling) a redundant re-render here.
    this._renderNewlyMountedRefs(newlyMountedRefs);

    // The DOM nodes backing the selection may be new (or, for a recycled
    // cell, may already have the right highlight class from before -- this
    // is idempotent either way) -- state (this.anchor/this.selected) is
    // unaffected by a remount, so just reapply it to whichever refs happen
    // to be mounted now; _highlightRange already no-ops for a ref with no
    // live node.
    if (this.anchor && this.selected) this._highlightRange(this.anchor, this.selected);

    if (this.onWindowChange) this.onWindowChange();
  }

  /**
   * Builds one <td> for `ref` (registering it in this._cellElements) --
   * shared by the full-mount path and the recycling path's "genuinely new
   * cell" case, so both apply IDENTICAL merge-span/height/overflow setup.
   * Caller is responsible for checking this._coverage first (a
   * merge-covered ref never gets its own node, on either path) and for
   * actually inserting the returned node into the DOM.
   */
  _createCellNode(ref, rowNum, rowHeight) {
    const td = document.createElement('td');
    td.dataset.ref = ref;
    td.tabIndex = -1;
    const merge = this.cells[ref] && this.cells[ref].merge;
    if (merge) {
      if (merge.cols > 1) td.colSpan = merge.cols;
      if (merge.rows > 1) td.rowSpan = merge.rows;
    }
    if (!merge || !merge.rows || merge.rows <= 1) {
      td.style.height = rowHeight + 'px';
      td.style.overflow = 'hidden';
    }
    this._cellElements.set(ref, td);
    return td;
  }

  /**
   * Builds one full <tr> (row header + spacer(s) + data cells) for row `r`
   * across column range [colStart, colEnd] -- shared by the full-mount path
   * and the recycling path's "genuinely new row" case. Registers the <tr>/
   * row-header <th> in this._rowElements/_rowHeaderElements, and stashes
   * the left/right spacer <td> elements directly on the <tr> itself
   * (`tr._leftSpacer`/`tr._rightSpacer`) so a later column-window change
   * that keeps this same row mounted (_reconcileRowColumns) can find and
   * resize/remove/recreate them in O(1) without re-querying the DOM. Does
   * NOT append the returned <tr> anywhere -- the caller decides where it
   * goes in the tbody.
   */
  _createRowNode(r, colStart, colEnd) {
    const rowNum = r + 1;
    const rowHeight = this.rowHeights[rowNum] || DEFAULT_ROW_HEIGHT;
    const tr = document.createElement('tr');
    tr.style.height = rowHeight + 'px';
    this._rowElements[r] = tr;
    const rowHead = document.createElement('th');
    rowHead.textContent = String(rowNum);
    rowHead.dataset.rowIndex = String(r);
    rowHead.addEventListener('mousedown', (e) => this._onRowHeaderMouseDown(e, r));
    rowHead.addEventListener('touchstart', (e) => this._onRowHeaderTouchStart(e, r), { passive: true });
    this._rowHeaderElements[r] = rowHead;
    rowHead.appendChild(this._rowResizeHandle(rowNum, tr));
    // See _build()'s original comment on this same block for why the
    // explicit height+overflow lives on each cell, not just the <tr>.
    rowHead.style.height = rowHeight + 'px';
    rowHead.style.overflow = 'hidden';
    tr.appendChild(rowHead);

    tr._leftSpacer = null;
    tr._rightSpacer = null;

    if (colStart > 0) {
      tr._leftSpacer = document.createElement('td');
      tr._leftSpacer.className = 'grid-spacer-cell';
      tr._leftSpacer.colSpan = colStart;
      tr.appendChild(tr._leftSpacer);
    }

    for (let c = colStart; c <= colEnd; c++) {
      const ref = colLetter(c) + rowNum;
      if (this._coverage.has(ref)) continue; // reserved by an earlier cell's colspan/rowspan
      tr.appendChild(this._createCellNode(ref, rowNum, rowHeight));
    }

    if (colEnd < this.cols - 1) {
      tr._rightSpacer = document.createElement('td');
      tr._rightSpacer.className = 'grid-spacer-cell';
      tr._rightSpacer.colSpan = this.cols - 1 - colEnd;
      tr.appendChild(tr._rightSpacer);
    }

    return tr;
  }

  /**
   * Removes row `r`'s <tr> (and its row-header <th>, and every data <td> it
   * held) from the DOM and from this._rowElements/_rowHeaderElements/
   * _cellElements -- used when a scroll-driven remount drops a row from the
   * window entirely. Cleaning up _cellElements here (not just detaching the
   * <tr>, which would clean up its children for free as far as the DOM goes)
   * is required for _cellEl()'s "null means not currently mounted" contract
   * to stay correct -- otherwise a removed row's cells would still resolve
   * to a (now-detached) node instead of null.
   */
  _removeRow(r) {
    const tr = this._rowElements[r];
    if (!tr) return;
    for (const child of tr.children) {
      if (child.dataset && child.dataset.ref) this._cellElements.delete(child.dataset.ref);
    }
    tr.remove();
    delete this._rowElements[r];
    delete this._rowHeaderElements[r];
  }

  /**
   * Full (re)mount of the tbody for the given window -- functionally
   * identical to _renderWindow's old unconditional behavior (build a brand
   * new <tbody>, discard whatever was there before). Used only when there's
   * no valid previous window to reconcile from (see _renderWindow's doc
   * comment on when that's the case) -- i.e. exactly the situations where
   * the old destroy/recreate approach's cost was never the problem in the
   * first place (once per structural rebuild or remote pixel-offset patch,
   * not once per scroll tick).
   */
  _mountWindowFull(win) {
    const { rowTops, rowStart, rowEnd, colStart, colEnd } = win;
    const tbody = document.createElement('tbody');
    this._cellElements = new Map();
    this._rowElements = [];
    this._rowHeaderElements = [];
    this._topSpacerRow = null;
    this._bottomSpacerRow = null;

    if (rowStart > 0) {
      this._topSpacerRow = this._makeSpacerRow(rowTops[rowStart], this.cols + 1);
      tbody.appendChild(this._topSpacerRow);
    }

    for (let r = rowStart; r <= rowEnd; r++) {
      tbody.appendChild(this._createRowNode(r, colStart, colEnd));
    }

    if (rowEnd < this.rows - 1) {
      this._bottomSpacerRow = this._makeSpacerRow(rowTops[this.rows] - rowTops[rowEnd + 1], this.cols + 1);
      tbody.appendChild(this._bottomSpacerRow);
    }

    if (this._tbody) this.table.replaceChild(tbody, this._tbody);
    else this.table.appendChild(tbody);
    this._tbody = tbody;
  }

  /**
   * Reconciles the currently-mounted tbody (built from `prevWindow`) toward
   * `win`, recycling every row/column that's in both ranges instead of
   * touching it at all, and returns the Set of refs that are newly mounted
   * this pass (genuinely new cells, from either a newly-created row or a
   * newly-entering column within a kept row) -- exactly what
   * _renderNewlyMountedRefs needs to render content for.
   *
   * Both `prevWindow` and `win`'s row (and column) ranges are contiguous
   * integer intervals (see _computeVisibleWindow), so "removed" is always
   * at most a prefix + a suffix of the old range, and "added" is always at
   * most a prefix + a suffix of the new range -- true even for a large,
   * non-overlapping jump (e.g. Home/End or a fast fling), where the
   * min/max-clamped ranges below correctly degenerate to "remove
   * everything old" / "add everything new". No generic set-diffing needed.
   */
  _reconcileWindow(prevWindow, win) {
    const { rowTops, rowStart, rowEnd, colStart, colEnd } = win;
    const pRS = prevWindow.rowStart, pRE = prevWindow.rowEnd;
    const pCS = prevWindow.colStart, pCE = prevWindow.colEnd;
    const tbody = this._tbody;
    const newlyMounted = new Set();

    // Spacer rows are cheap (one <tr>/<td> pair each) -- always drop and
    // recreate them fresh at the end, rather than reconciling them like
    // real content rows. Removing them up front also means the "current
    // first/last child" anchors used below never have to account for them.
    if (this._topSpacerRow) { this._topSpacerRow.remove(); this._topSpacerRow = null; }
    if (this._bottomSpacerRow) { this._bottomSpacerRow.remove(); this._bottomSpacerRow = null; }

    // Rows leaving the window (top edge, then bottom edge).
    for (let r = pRS; r <= Math.min(pRE, rowStart - 1); r++) this._removeRow(r);
    for (let r = Math.max(pRS, rowEnd + 1); r <= pRE; r++) this._removeRow(r);

    // Rows kept in both windows: recycle the <tr> in place, only
    // adjusting its columns (which may themselves have changed).
    const keptRowStart = Math.max(pRS, rowStart);
    const keptRowEnd = Math.min(pRE, rowEnd);
    for (let r = keptRowStart; r <= keptRowEnd; r++) {
      const tr = this._rowElements[r];
      if (!tr) continue; // shouldn't happen, but never crash rendering over it
      this._reconcileRowColumns(r, tr, pCS, pCE, colStart, colEnd, newlyMounted);
    }

    // Rows newly entering the window (top edge, then bottom edge). Ascending
    // insertBefore(newTr, topAnchor) against the SAME fixed anchor node
    // produces ascending DOM order for free (each new row lands directly
    // before whatever was already there, pushing nothing else around) --
    // topAnchor is captured once, before any of these insertions, and stays
    // a valid reference throughout since none of these insertions remove
    // it. Bottom-entering rows use plain appendChild for the same reason,
    // in reverse (append preserves ascending order when done in ascending
    // source order).
    const topAnchor = tbody.firstChild;
    for (let r = rowStart; r <= Math.min(rowEnd, pRS - 1); r++) {
      tbody.insertBefore(this._createRowNode(r, colStart, colEnd), topAnchor);
      this._collectRowRefs(this._rowElements[r], newlyMounted);
    }
    for (let r = Math.max(rowStart, pRE + 1); r <= rowEnd; r++) {
      tbody.appendChild(this._createRowNode(r, colStart, colEnd));
      this._collectRowRefs(this._rowElements[r], newlyMounted);
    }

    if (rowStart > 0) {
      this._topSpacerRow = this._makeSpacerRow(rowTops[rowStart], this.cols + 1);
      tbody.insertBefore(this._topSpacerRow, tbody.firstChild);
    }
    if (rowEnd < this.rows - 1) {
      this._bottomSpacerRow = this._makeSpacerRow(rowTops[this.rows] - rowTops[rowEnd + 1], this.cols + 1);
      tbody.appendChild(this._bottomSpacerRow);
    }

    return newlyMounted;
  }

  /** Adds every data-cell ref found among `tr`'s children into `into` (a
   * Set) -- used right after _createRowNode to record which refs a
   * brand-new row just introduced, for _reconcileWindow's return value. */
  _collectRowRefs(tr, into) {
    if (!tr) return;
    for (const child of tr.children) {
      if (child.dataset && child.dataset.ref) into.add(child.dataset.ref);
    }
  }

  /**
   * Reconciles a single KEPT row's columns from [prevColStart, prevColEnd]
   * to [colStart, colEnd] -- removes cells leaving at either edge, resizes/
   * creates/removes the left/right spacer <td>s, and creates cells newly
   * entering at either edge, inserting each at the correct position without
   * disturbing any cell that was already there and stays. Newly-created
   * refs are added to `newlyMounted` (mutated in place) so the caller can
   * render their content afterward.
   *
   * Insertion uses the same "ascending inserts against one fixed anchor"
   * trick _reconcileWindow uses for rows (see there): `leftAnchor` and
   * `rightAnchor` are captured once, before any mutation that could affect
   * them, and referenced as actual DOM nodes (not positions/indices), so
   * they stay valid through every subsequent insertBefore/remove/create
   * this method does.
   *
   * Deliberately does NOT touch a kept cell's rowSpan/colSpan (unlike the
   * fresh-creation path in _createCellNode, which sets it from
   * this.cells[ref].merge) -- merges only ever change via a structural
   * _build() rebuild, which always does a full remount (_mountWindowFull),
   * never reaches this method with a stale span. Within one _build()
   * generation, a given ref's merge span is invariant across any number of
   * scroll-driven reconciliations.
   */
  _reconcileRowColumns(r, tr, prevColStart, prevColEnd, colStart, colEnd, newlyMounted) {
    const rowNum = r + 1;
    const rowHeight = this.rowHeights[rowNum] || DEFAULT_ROW_HEIGHT;

    // Columns leaving on the left edge, then the right edge. A covered
    // (merge-spanned-over) ref never had an entry in this._cellElements,
    // so the lookup is just a no-op for those -- safe either way.
    for (let c = prevColStart; c <= Math.min(prevColEnd, colStart - 1); c++) {
      const ref = colLetter(c) + rowNum;
      const td = this._cellElements.get(ref);
      if (td) { td.remove(); this._cellElements.delete(ref); }
    }
    for (let c = Math.max(prevColStart, colEnd + 1); c <= prevColEnd; c++) {
      const ref = colLetter(c) + rowNum;
      const td = this._cellElements.get(ref);
      if (td) { td.remove(); this._cellElements.delete(ref); }
    }

    // Captured BEFORE touching the left spacer -- if a left spacer already
    // existed, this is exactly the first surviving element after it (the
    // leftmost kept cell, or the right spacer, or null); if it didn't,
    // tr.children[1] (index 0 is always the row-header <th>) is that same
    // "first surviving element" directly. Either way this reference stays
    // valid through the spacer create/resize/remove below and the
    // left-edge insert loop after it.
    const leftAnchor = tr._leftSpacer ? tr._leftSpacer.nextSibling : (tr.children[1] || null);

    if (colStart > 0) {
      if (!tr._leftSpacer) {
        tr._leftSpacer = document.createElement('td');
        tr._leftSpacer.className = 'grid-spacer-cell';
        tr.insertBefore(tr._leftSpacer, tr.children[1] || null);
      }
      tr._leftSpacer.colSpan = colStart;
    } else if (tr._leftSpacer) {
      tr._leftSpacer.remove();
      tr._leftSpacer = null;
    }

    // Columns newly entering on the left edge, ascending, each inserted
    // right before leftAnchor -- see the class-level doc comment for why
    // ascending source order against one fixed anchor yields ascending DOM
    // order.
    const leftAddEnd = Math.min(colEnd, prevColStart - 1);
    for (let c = colStart; c <= leftAddEnd; c++) {
      const ref = colLetter(c) + rowNum;
      if (this._coverage.has(ref)) continue;
      tr.insertBefore(this._createCellNode(ref, rowNum, rowHeight), leftAnchor);
      newlyMounted.add(ref);
    }

    // Captured before touching the right spacer, for the same reason as
    // leftAnchor above.
    const rightAnchor = tr._rightSpacer || null;
    const rightAddStart = Math.max(prevColEnd + 1, colStart);
    for (let c = rightAddStart; c <= colEnd; c++) {
      const ref = colLetter(c) + rowNum;
      if (this._coverage.has(ref)) continue;
      tr.insertBefore(this._createCellNode(ref, rowNum, rowHeight), rightAnchor);
      newlyMounted.add(ref);
    }

    if (colEnd < this.cols - 1) {
      if (!tr._rightSpacer) {
        tr._rightSpacer = document.createElement('td');
        tr._rightSpacer.className = 'grid-spacer-cell';
        tr.appendChild(tr._rightSpacer); // every real cell for this row is already placed -- true end is correct
      }
      tr._rightSpacer.colSpan = this.cols - 1 - colEnd;
    } else if (tr._rightSpacer) {
      tr._rightSpacer.remove();
      tr._rightSpacer = null;
    }
  }

  /** A single spacer <tr> occupying `height`px, standing in for every row
   * currently outside the rendered window (see _renderWindow) -- keeps the
   * scroll container's total scrollable height (and so scrollbar size/
   * position) correct without needing a real <tr>/<td> per skipped row.
   * colSpan covers the row-header column too (`this.cols + 1`), same as
   * every real data row's row-header <th> + this.cols data <td>s. */
  _makeSpacerRow(height, colSpan) {
    const tr = document.createElement('tr');
    tr.className = 'grid-spacer-row';
    const td = document.createElement('td');
    td.className = 'grid-spacer-cell';
    td.colSpan = colSpan;
    td.style.height = Math.max(0, height) + 'px';
    tr.appendChild(td);
    return tr;
  }

  /** Scroll handler for the windowed render -- rAF-throttled so a fast
   * scroll/fling (which can fire many scroll events per frame on some
   * platforms) recomputes the window at most once per paint, not once per
   * event. */
  _onScroll() {
    if (this._scrollRafPending) return;
    this._scrollRafPending = true;
    requestAnimationFrame(() => {
      this._scrollRafPending = false;
      this._renderWindow();
    });
  }

  /** Starts the drag-select auto-scroll interval if not already running --
   * see _dragAutoScrollTick's doc comment for why this is interval-driven
   * rather than purely mousemove/touchmove-driven. Called from every
   * drag-start site (_onMouseDown, _onRowHeaderMouseDown/
   * _onColHeaderMouseDown, the touch drag-arm timer in
   * _armTouchDragCandidate). */
  _startDragAutoScroll() {
    if (this._dragAutoScrollTimer) return;
    this._dragAutoScrollTimer = setInterval(() => this._dragAutoScrollTick(), 50);
  }

  /** Stops the drag-select auto-scroll interval -- called from every
   * drag-end site (_onMouseUp, _onTouchEnd). Safe to call when not running. */
  _stopDragAutoScroll() {
    if (this._dragAutoScrollTimer) {
      clearInterval(this._dragAutoScrollTimer);
      this._dragAutoScrollTimer = null;
    }
    this._lastPointerXY = null;
  }

  /**
   * Nudges the scroll container toward the pointer whenever an active
   * drag-select (plain cell range, or whole-row/whole-column header range)
   * is held near a viewport edge -- standard spreadsheet-app behavior
   * (Excel/Sheets both do this), and a real requirement under windowing:
   * without it, a drag can never reach a row/column outside the current
   * render window at all, since the window otherwise only ever moves via
   * an explicit user scroll gesture, which a held mouse-button drag can't
   * also perform at the same time.
   *
   * Runs on a plain interval (_startDragAutoScroll), not directly off
   * mousemove/touchmove -- mousemove stops firing entirely once the
   * pointer itself stops moving, so a pointer deliberately held still at
   * the very edge (the normal way to trigger this in every spreadsheet
   * app) would otherwise never advance. `_lastPointerXY` (kept fresh by
   * every mousemove/touchmove during a drag) is what this reads instead of
   * an event.
   *
   * After actually moving the scroll position, re-renders the window
   * immediately (not waiting for the container's async 'scroll' event +
   * _onScroll's rAF throttle) and re-resolves the selection at the last
   * known pointer position via elementFromPoint -- the pointer itself
   * hasn't moved, but the DOM under it has (a previously off-screen row/
   * column may now be mounted), so the drag has to re-hit-test rather than
   * wait for the next real mousemove/touchmove (which may never come if
   * the pointer stays perfectly still at the edge).
   */
  _dragAutoScrollTick() {
    if (!this._dragging && !this._headerDragging) { this._stopDragAutoScroll(); return; }
    const xy = this._lastPointerXY;
    if (!xy || !this.container) return;
    const rect = this.container.getBoundingClientRect();
    const margin = 36;
    const step = 22;
    let dy = 0, dx = 0;
    if (xy.y < rect.top + margin) dy = -step;
    else if (xy.y > rect.bottom - margin) dy = step;
    if (xy.x < rect.left + margin) dx = -step;
    else if (xy.x > rect.right - margin) dx = step;
    if (!dx && !dy) return;
    const prevTop = this.container.scrollTop;
    const prevLeft = this.container.scrollLeft;
    this.container.scrollTop = Math.max(0, prevTop + dy);
    this.container.scrollLeft = Math.max(0, prevLeft + dx);
    if (this.container.scrollTop === prevTop && this.container.scrollLeft === prevLeft) return; // already at a scroll limit
    this._renderWindow();
    if (this._headerDragging === 'row') {
      const el = this._resolveDragTarget('row', xy.x, xy.y);
      const th = el && el.closest('tbody th');
      if (th && th.dataset.rowIndex !== undefined) this.selectWholeRow(Number(th.dataset.rowIndex), true);
    } else if (this._headerDragging === 'col') {
      const el = this._resolveDragTarget('col', xy.x, xy.y);
      const th = el && el.closest('thead th');
      if (th && th.dataset.colIndex !== undefined) this.selectWholeColumn(Number(th.dataset.colIndex), true);
    } else if (this._dragging) {
      const el = this._resolveDragTarget('cell', xy.x, xy.y);
      const td = el && el.closest('td');
      if (td && td.dataset.ref && td.dataset.ref !== this.selected) {
        this.selected = td.dataset.ref;
        this._highlightRange(this.anchor, this.selected);
        if (this.onSelectionChange) this.onSelectionChange(this.selected);
      }
    }
  }

  /**
   * Re-resolves what's "under" client position (x, y) for drag-select
   * hit-testing -- used by _onMouseMoveDrag, _dragAutoScrollTick above, and
   * _onTouchMove instead of a bare document.elementFromPoint/e.target,
   * because the pointer during an active drag is routinely sitting
   * exactly on top of one of the grid's STICKY overlays (the row-header
   * column, sticky at the left edge, or the column-header row, sticky at
   * the top edge) rather than on the kind of element the current drag
   * actually needs:
   *
   * - A plain cell-range drag (`kind: 'cell'`) needs a <td>. Auto-scroll
   *   specifically engages when the pointer is held near the left/top
   *   viewport edge (see _dragAutoScrollTick above) -- exactly where the
   *   sticky row-header/column-header overlay sits, so a naive hit-test
   *   there lands on a <th>, not a <td>, and the drag silently stops
   *   extending even though auto-scroll keeps running (confirmed live:
   *   this is what made a drag-select's final selection get truncated at
   *   that edge).
   * - A row-header drag (`kind: 'row'`) needs a `tbody th`. A natural
   *   diagonal drag easily carries the pointer's x off the header
   *   column's narrow track onto the data grid entirely, which hit-tests
   *   to a <td> instead -- same failure mode, transposed.
   * - A col-header drag (`kind: 'col'`) is the transposed counterpart of
   *   that (pointer's y drifts off the header row onto the data grid).
   *
   * Strategy: try the natural (unclamped) hit-test first -- the
   * overwhelming majority of drag ticks/moves land exactly where expected
   * and never need anything else. Only if that doesn't resolve to the
   * kind of element this drag needs, clamp x/y just onto/past whichever
   * sticky overlay is relevant for `kind` and re-test:
   *   - cell: push the tested x past the sticky row-header column (if x
   *     was within it) and the tested y past the sticky column-header row
   *     (if y was within it), landing just inside the data-cell area on
   *     whichever axis wasn't already fine.
   *   - row: pull the tested x back ONTO the row-header column's own
   *     x-range (y -- what actually determines which row -- is left
   *     alone, since it's still an accurate reflection of where the
   *     pointer really is).
   *   - col: pull the tested y back onto the column-header row's own
   *     y-range (x left alone), the transposed counterpart.
   */
  _resolveDragTarget(kind, x, y) {
    const first = document.elementFromPoint(x, y);
    const matches = (el) => {
      if (!el) return false;
      if (kind === 'cell') return !!el.closest('td');
      if (kind === 'row') return !!el.closest('tbody th');
      // 'col': the empty top-left CORNER <th> (built before the per-column
      // loop in _build(), see there) also matches a bare
      // `el.closest('thead th')` test -- it IS a `thead th` -- but it has
      // no data-col-index and isn't a real column header, so accepting it
      // here would return early (below) with a "match" that every caller's
      // own `th.dataset.colIndex !== undefined` check then rejects,
      // silently freezing the drag instead of falling through to the
      // clamp logic that would have found the real column-header <th>.
      const th = el.closest('thead th');
      return !!th && th.dataset.colIndex !== undefined;
    };
    if (matches(first)) return first;
    if (!this.container || !this.table) return first;
    // getBoundingClientRect() reports the container's BORDER box -- rect.
    // left/rect.top are the outer edge of its 1px `.grid-scroll` border
    // (see app.css), not where its content (and the sticky th's stuck to
    // it) actually starts. The sticky row-header/column-header elements are
    // positioned relative to the content box, one border-width further in,
    // so clamping straight off rect.left/rect.top (as this used to) landed
    // short by exactly that border width -- at the scroll floor (scrollTop/
    // scrollLeft === 0, the only time this clamp path is actually reachable
    // for the true top-left corner) elementFromPoint at the clamped point
    // then still hit the sticky <th> instead of the intended <td>, so a
    // drag-select could get right up to the corner and then permanently
    // stop extending on that axis even though auto-scroll kept scrolling.
    // Confirmed via real-Chromium measurement: rowHeaderTh/thead's own
    // getBoundingClientRect().left/top already sit at rect.left/top +
    // this border width, not at rect.left/top directly.
    const containerStyle = getComputedStyle(this.container);
    const borderLeft = parseFloat(containerStyle.borderLeftWidth) || 0;
    const borderTop = parseFloat(containerStyle.borderTopWidth) || 0;
    const rect = this.container.getBoundingClientRect();
    const contentLeft = rect.left + borderLeft;
    const contentTop = rect.top + borderTop;
    const rowHeaderTh = this.table.querySelector('tbody th');
    const stickyLeftWidth = rowHeaderTh ? rowHeaderTh.getBoundingClientRect().width : ROW_HEADER_WIDTH;
    const thead = this.table.querySelector('thead');
    const stickyTopHeight = thead ? thead.getBoundingClientRect().height : 0;
    let cx = x, cy = y;
    if (kind === 'cell') {
      if (x < contentLeft + stickyLeftWidth) cx = contentLeft + stickyLeftWidth + 1;
      if (y < contentTop + stickyTopHeight) cy = contentTop + stickyTopHeight + 1;
    } else if (kind === 'row') {
      cx = contentLeft + Math.min(stickyLeftWidth - 1, stickyLeftWidth / 2);
      // Same y-clamp as 'cell' above: the pointer during a row-header drag
      // held straight up toward row 1 is naturally sitting inside the
      // sticky thead band (that's the direction it's being dragged), which
      // hit-tests to a thead <th>, not the tbody <th> this kind needs --
      // without also pushing y past it here, the drag freezes just short
      // of row 1 even though scrollTop correctly reaches 0.
      if (y < contentTop + stickyTopHeight) cy = contentTop + stickyTopHeight + 1;
    } else {
      cy = contentTop + Math.min(stickyTopHeight - 1, stickyTopHeight / 2);
      // Transposed counterpart: a col-header drag held toward column A is
      // naturally sitting inside the sticky row-header column, which
      // hit-tests to that column (or the top-left CORNER <th> -- see
      // `matches` above) instead of a real column-header <th>.
      if (x < contentLeft + stickyLeftWidth) cx = contentLeft + stickyLeftWidth + 1;
    }
    if (cx === x && cy === y) return first; // clamping wouldn't change anything -- nothing more to try
    return document.elementFromPoint(cx, cy);
  }

  _renderCell(ref) {
    const el = this._cellEl(ref);
    if (!el) return; // covered by a merge, or not yet built -- nothing to render
    el.innerHTML = ''; // clear any previous content/wrapper left from a prior render
    const cell = this.cells[ref];
    const raw = cell && cell.value !== undefined ? cell.value : '';

    // Content goes in an inner wrapper, not directly in the <td>, and
    // it's this wrapper -- not the <td> -- that gets the explicit
    // height + overflow:hidden clamp. A <td>'s own `height` is only a
    // floor in table layout (same reason a <tr height> is, see _build()'s
    // comment on that) -- a large font-size's natural line box still
    // grows the row even with overflow:hidden set directly on the <td>,
    // because the *used* height feeding the table's row-height algorithm
    // is computed from content before that clip is applied. A normal
    // block-level child with its own explicit height has no such
    // table-layout floor semantics -- overflow:hidden on IT reliably
    // clips regardless of font size, and the <td>'s own natural content
    // height (what the row-height algorithm actually sees) becomes just
    // "the wrapper's height", not the raw text's. This is what "changing
    // font size should not resize cell to fit" needed -- setting
    // height+overflow on the <td> alone (the previous attempt) looked
    // right in code and in a DOM-structure test, but never actually
    // clipped in real table layout.
    const inner = document.createElement('div');
    inner.className = 'cell-content';
    const merge = cell && cell.merge;
    if (!merge || !merge.rows || merge.rows <= 1) {
      const { row: rowIdx } = parseRef(ref);
      const rowHeight = this.rowHeights[rowIdx + 1] || DEFAULT_ROW_HEIGHT;
      inner.style.height = rowHeight + 'px';
      inner.style.overflow = 'hidden';
    }
    // A rowSpan>1 merge origin: no fixed height here either, matching
    // _build()'s same skip for the <td> itself -- its natural height is
    // the sum of the rows it spans.
    el.appendChild(inner);

    // ACTIONGROUP is checked before the normal formula evaluator -- see
    // parseActionGroup() in formulas.js for why it can't go through
    // evaluateFormula() like SUM etc.
    const actionGroup = parseActionGroup(raw);
    if (actionGroup) {
      this._renderActionGroupCell(ref, inner, actionGroup, cell);
    } else {
      inner.textContent = isFormula(raw) ? String(evaluateFormula(raw, (r) => this._resolveRef(r))) : displayableCellValue(raw);
    }

    const fmt = (cell && cell.format) || {};
    el.classList.toggle('bold', !!fmt.bold);
    el.classList.toggle('italic', !!fmt.italic);
    el.classList.toggle('underline', !!fmt.underline);
    el.classList.toggle('wrap', !!fmt.wrap);
    el.style.color = fmt.color || '';
    el.style.background = fmt.bg || '';
    el.style.fontFamily = FONT_FAMILIES[fmt.fontFamily] || '';
    el.style.fontSize = fmt.fontSize ? fmt.fontSize + 'pt' : '';
  }

  /**
   * Renders a cell whose raw value parsed as an ACTIONGROUP(...) call (see
   * parseActionGroup() in formulas.js and CELL_SCHEMA.md for the full
   * design) -- a single button; clicking it runs every action in order (see
   * _runActionGroup). `hideOnClick` disabling is read from `cell.actionState`
   * (persisted on the cell, in the shared document -- see _runActionGroup),
   * not client-side/session state, so every connected viewer sees the same
   * disabled state, including after a reload/reconnect.
   *
   * `hideOnClick=TRUE` disabling also requires at least one tracked target
   * cell to currently hold a value -- Fernando: "when all cells an
   * actiongroup is tracking get cleared, reset the button... disabled if
   * any of the tracked cells have a value and it was clicked once."
   * `actionState.clicked` itself is never reset back to false; this is
   * computed fresh every render instead, which stays correct for free --
   * clearing a target cell already re-renders this cell via
   * _recalcDependents(), since extractReferences() picks up a USERINFO
   * action's cell ref as a dependency of the ACTIONGROUP formula the same
   * as any other reference (see _buildDependents()'s own comment).
   */
  _renderActionGroupCell(ref, el, { buttonText, hideOnClick, actions }, cell) {
    const clicked = !!(cell && cell.actionState && cell.actionState.clicked);
    const anyTrackedValuePresent = actions.some((a) => a.cell && this.cells[a.cell] && this.cells[a.cell].value);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'actiongroup-btn';
    btn.textContent = buttonText;
    btn.disabled = this.readOnly || (hideOnClick && clicked && anyTrackedValuePresent);
    btn.addEventListener('mousedown', (e) => e.stopPropagation()); // don't start a drag-select under the button
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      this._runActionGroup(ref, actions, hideOnClick);
    });
    el.appendChild(btn);
  }

  /**
   * Runs every action in an ACTIONGROUP click, in order. First collects
   * every user-resolvable field referenced anywhere in the group (via
   * ACTION_NEEDS, deduped by key) and, only if at least one is missing a
   * value, awaits ONE consolidated prompt (this.onNeedUserInfo -- app.js's
   * job to actually render, this file has no dialog machinery of its own,
   * same split as _onContextMenu/mergeSelection elsewhere here) listing
   * ALL of them (not just the missing ones, so an already-known field is
   * still shown, pre-filled and editable) before running anything -- one
   * dialog per click, not one native prompt per missing field. Each
   * action's target cell is then written via setCellValue() -- the same
   * commit path as typing/the formula bar/paste -- so a saveOnEdit watch
   * on that same target (see _buildActionGroupWatches) also gets a chance
   * to fire (a no-op in practice: the value being written back to
   * cookie/DB is the same one just read from there). An action left
   * blank in the dialog (or the whole dialog dismissed with something still
   * pre-filled) is skipped without aborting the rest -- but a genuine
   * backdrop-click/Escape cancel of the dialog (this.onNeedUserInfo
   * resolving `null`, as opposed to resolving an object of entered/blank
   * values) aborts the WHOLE click instead: no action runs, not even ones
   * whose value was already known before the dialog opened, and
   * `hideOnClick` doesn't apply either. Fernando: clicking outside the
   * dialog should mean nothing happened, not "fill in whatever was already
   * known and skip the rest." Only reachable when the dialog was actually
   * shown (see the `if` just above) -- if nothing was missing, the dialog
   * never opens and `entered` is never even asked for, so there's nothing
   * to have cancelled.
   *
   * hideOnClick's disabled state is a separate, explicit patch to the
   * ACTIONGROUP cell itself (`actionState`, not `value` -- the formula
   * stays intact so re-rendering after a reload still shows the same
   * button, just disabled) -- persisted in the shared document so every
   * connected viewer sees it, not just the clicker.
   */
  async _runActionGroup(ref, actions, hideOnClick) {
    if (this.readOnly) return;

    const fields = new Map();
    for (const action of actions) {
      const need = ACTION_NEEDS[action.type] && ACTION_NEEDS[action.type](action);
      if (need && !fields.has(need.key)) fields.set(need.key, need);
    }
    const resolved = Object.fromEntries([...fields].map(([key, need]) => [key, need.value]));
    if ([...fields.values()].some((need) => !need.value)) {
      const entered = await this.onNeedUserInfo([...fields.entries()].map(([infoType, need]) => ({
        infoType, value: need.value, displayText: need.displayText, validValues: need.validValues,
      })));
      if (entered === null) return; // backdrop/Escape cancel -- abort the whole click, run nothing
      for (const [key, value] of Object.entries(entered)) {
        const trimmed = (value || '').trim();
        if (trimmed) { setUserInfoField(key, trimmed); resolved[key] = trimmed; }
      }
    }

    for (const action of actions) {
      const executor = ACTION_EXECUTORS[action.type];
      if (!executor) continue;
      const result = executor(action, resolved);
      if (result === null || result === undefined) continue;
      if (this._isCovered(action.cell)) continue;
      this.setCellValue(action.cell, result);
    }
    if (hideOnClick) {
      const cell = this.cells[ref] || {};
      this.cells[ref] = { ...cell, actionState: { clicked: true } };
      this.onChange({ cells: { [ref]: { actionState: { clicked: true } } } });
      this._renderCell(ref);
    }
  }

  /**
   * Per-tab "which cells are saveOnEdit targets" registry, rebuilt fresh on
   * every call (same rationale as _buildDependents: cheap at this sheet
   * size, never goes stale). Scans every ACTIONGROUP formula for USERINFO
   * actions with saveOnEdit=true and maps their target cell -> infoType.
   * setCellValue() consults this on every LOCAL edit (see there) -- this is
   * Fernando's "a change in another cell should be caught by this cell to
   * trigger the cookie saving": the ACTIONGROUP/USERINFO formula lives in
   * one cell, but the value a viewer hand-types lands in a *different*
   * cell (the USERINFO action's target), so the watch has to be built by
   * looking at every formula on the sheet, not just the edited cell itself.
   */
  _buildActionGroupWatches() {
    const watches = new Map();
    for (const [sourceRef, cell] of Object.entries(this.cells)) {
      if (!cell || !isFormula(cell.value)) continue;
      const actionGroup = parseActionGroup(cell.value);
      if (!actionGroup) continue;
      for (const action of actionGroup.actions) {
        if (action.type === 'USERINFO' && action.saveOnEdit) {
          // sourceRef travels with the watch (not just infoType) so a
          // caller clearing multiple cells in one operation can tell
          // whether the ACTIONGROUP itself is ALSO being removed here --
          // see _clearSelection().
          watches.set(action.cell, { infoType: action.infoType, sourceRef });
        }
      }
    }
    return watches;
  }

  /**
   * Resolves a ref to its evaluated value (number or string) for use inside
   * another cell's formula. this._resolvingRefs tracks which refs are
   * currently mid-resolution on the current (synchronous) call chain -- a
   * classic DFS "gray set" -- so a circular reference (A1="=B1", B1="=A1")
   * returns '#ERROR' the second time a ref is revisited instead of
   * recursing forever and crashing the tab. Added to the set right before
   * recursing and removed right after (try/finally) so it only reflects
   * the current path, not every ref ever resolved -- a diamond dependency
   * (C1 depends on both A1 and B1, which both depend on D1) is not a cycle
   * and must not be flagged as one.
   */
  _resolveRef(ref) {
    const cell = this.cells[ref];
    if (!cell || cell.value === undefined) return '';
    if (!isFormula(cell.value)) return cell.value;
    if (!this._resolvingRefs) this._resolvingRefs = new Set();
    if (this._resolvingRefs.has(ref)) return '#ERROR';
    this._resolvingRefs.add(ref);
    try {
      return evaluateFormula(cell.value, (r) => this._resolveRef(r));
    } finally {
      this._resolvingRefs.delete(ref);
    }
  }

  /**
   * Per-tab "which formula cells read this ref" graph, rebuilt fresh on
   * every call rather than incrementally maintained -- sheets here are
   * small (default 6x20, user-resizable but not spreadsheet-app-scale) so
   * an O(cells) rebuild is cheap, and a fresh rebuild can never go stale
   * the way an incrementally-patched graph could (e.g. forgetting to drop
   * an edge when a formula is replaced with a literal). Keyed by the
   * REFERENCED cell -> Set of formula cells that depend on it, which is
   * the direction _recalcDependents needs to walk (starting from "this ref
   * just changed").
   *
   * An ACTIONGROUP cell's USERINFO(cell, ...) action refs also show up here
   * (extractReferences() doesn't distinguish "reads this ref" from "writes
   * this ref") -- harmless over-inclusion: it just means the ACTIONGROUP
   * cell's button gets an extra re-render (still showing the same label/
   * disabled state) when one of its own action targets changes, not an
   * incorrect one.
   */
  _buildDependents() {
    const dependents = new Map();
    for (const [ref, cell] of Object.entries(this.cells)) {
      if (!cell || !isFormula(cell.value)) continue;
      for (const dep of extractReferences(cell.value)) {
        if (!dependents.has(dep)) dependents.set(dep, new Set());
        dependents.get(dep).add(ref);
      }
    }
    return dependents;
  }

  /**
   * Re-renders every formula cell that transitively depends on any of
   * `changedRefs` -- this is what makes e.g. D1="=B1+C1" update when B1 is
   * edited, instead of only ever reflecting a fresh value when D1 itself is
   * directly touched. A breadth-first walk over _buildDependents(), not a
   * topological sort: _renderCell/_resolveRef always recompute a cell's
   * value fresh from live this.cells state (recursing into whatever THAT
   * cell references), so re-rendering dependents in any order still lands
   * on the correct final value for each -- this only needs to know WHICH
   * cells to re-render, not in what order.
   *
   * Call this after any change that updates this.cells outside of a full
   * _build() rebuild (setCellValue, applyRemote's non-structural cell
   * branch, _clearSelection, USERINFO's direct-mutation renders) --
   * anything that already triggers _build() (merge/unmerge, remote
   * structural patches, insert/delete row/col) re-renders every mounted
   * cell via _build()'s fresh _renderWindow() mount regardless, so
   * dependents are already covered there.
   */
  _recalcDependents(changedRefs) {
    const dependents = this._buildDependents();
    const visited = new Set(changedRefs);
    const queue = [...changedRefs];
    const toRender = new Set();
    while (queue.length) {
      const ref = queue.shift();
      const deps = dependents.get(ref);
      if (!deps) continue;
      for (const dep of deps) {
        if (visited.has(dep)) continue;
        visited.add(dep);
        toRender.add(dep);
        queue.push(dep);
      }
    }
    for (const ref of toRender) {
      if (!this._isCovered(ref)) this._renderCell(ref);
    }
  }

  _onMouseDown(e) {
    // Only the left button starts a selection. Without this check, a
    // middle-click here called preventDefault() and started a drag same
    // as a left-click -- which also suppresses the browser's native
    // middle-click autoscroll (that gesture starts on mousedown and is
    // cancelled by any preventDefault on it), so middle-clicking a cell
    // silently ate autoscroll and selected the cell instead. Right-click
    // (button 2) is handled separately by _onContextMenu and must also
    // not fall through to selection logic here.
    if (e.button !== 0) return;
    if (e.target.closest('.col-resize-handle') || e.target.closest('.row-resize-handle')) return;
    const td = e.target.closest('td');
    // A spacer <td> (see _renderWindow/_makeSpacerRow) stands in for a
    // whole range of currently-unmounted rows/columns -- it has no
    // dataset.ref (no single cell it represents), so treat a hit on one
    // the same as no cell at all rather than selecting `undefined`.
    if (!td || !td.dataset.ref) return;
    // Stop native text-selection/drag-highlight; our own selection
    // handling below is what should happen instead.
    e.preventDefault();
    this._dragging = true;
    this._lastPointerXY = { x: e.clientX, y: e.clientY };
    this._startDragAutoScroll();
    this._select(td.dataset.ref, e.shiftKey);
  }

  _onMouseMoveDrag(e) {
    // Kept fresh on every drag-relevant move regardless of which branch
    // below actually applies -- _dragAutoScrollTick (see there) reads this
    // on an interval, independent of whether mousemove itself keeps firing.
    if (this._dragging || this._headerDragging) this._lastPointerXY = { x: e.clientX, y: e.clientY };
    // Dragging across row/col headers (started by _onRowHeaderMouseDown/
    // _onColHeaderMouseDown below) extends a whole-row/whole-column
    // selection instead of the plain cell-range drag below -- same
    // mousemove listener, different branch, since both need "which header
    // is the pointer over right now" from the same event.
    if (this._headerDragging === 'row') {
      // e.target alone (rather than _resolveDragTarget) is only reliable
      // while the pointer stays on the narrow header track itself -- a
      // natural diagonal drag easily carries it off that track onto the
      // data grid instead, which would otherwise silently freeze the
      // row-header drag's selection. See _resolveDragTarget's doc comment.
      const el = this._resolveDragTarget('row', e.clientX, e.clientY);
      const th = el && el.closest('tbody th');
      if (th && th.dataset.rowIndex !== undefined) this.selectWholeRow(Number(th.dataset.rowIndex), true);
      return;
    }
    if (this._headerDragging === 'col') {
      const el = this._resolveDragTarget('col', e.clientX, e.clientY);
      const th = el && el.closest('thead th');
      if (th && th.dataset.colIndex !== undefined) this.selectWholeColumn(Number(th.dataset.colIndex), true);
      return;
    }
    if (!this._dragging) return;
    // A plain cell-range drag held near the left/top viewport edge (right
    // where auto-scroll engages, see _dragAutoScrollTick) is routinely
    // over the sticky row-header/column-header overlay instead of a <td>
    // -- e.target alone would silently stop extending the selection there
    // even though auto-scroll keeps running. See _resolveDragTarget.
    const el = this._resolveDragTarget('cell', e.clientX, e.clientY);
    const td = el && el.closest('td');
    if (!td || !td.dataset.ref || td.dataset.ref === this.selected) return;
    this.selected = td.dataset.ref;
    this._highlightRange(this.anchor, this.selected);
    if (this.onSelectionChange) this.onSelectionChange(this.selected);
  }

  _onMouseUp() {
    // Reset once this mouse gesture is fully over -- otherwise a stale
    // right-click button value could keep suppressing _onContainerFocus's
    // auto-select cascade for an unrelated LATER focus event (e.g. Tab)
    // that had nothing to do with a mousedown at all. Safe to clear here
    // regardless of mouseup-vs-contextmenu firing order for the SAME
    // right-click gesture -- _onContainerFocus already ran (or didn't)
    // synchronously as part of that mousedown's own default action, well
    // before either mouseup or contextmenu fires.
    this._lastMouseDownButton = null;
    if (this._headerDragging) {
      this._headerDragging = null;
      this._stopDragAutoScroll();
      this.container.dispatchEvent(new CustomEvent('cellselect', { detail: { ref: this.selected } }));
      return;
    }
    if (!this._dragging) return;
    this._dragging = false;
    this._stopDragAutoScroll();
    this.container.dispatchEvent(new CustomEvent('cellselect', { detail: { ref: this.selected } }));
  }

  _onCellDblClick(e) {
    const td = e.target.closest('td');
    if (!td || !td.dataset.ref || this.readOnly) return;
    this._beginEdit(td.dataset.ref);
  }

  /**
   * Right-click on a cell or a row/col header: suppress the browser's
   * native menu and dispatch a 'gridcontextmenu' CustomEvent instead --
   * app.js listens for it and renders the actual menu (positioning,
   * dismiss-on-click-outside, the menu items themselves all live there,
   * consistent with how mergeSelection()/unmergeSelection() return
   * {ok,error} for app.js to surface rather than grid.js owning any
   * dialog/toast UI itself).
   *
   * Right-clicking a cell/header OUTSIDE the current selection replaces
   * the selection with just that one cell/row/column first (matching
   * Excel/Sheets) -- right-clicking WITHIN an existing multi-cell or
   * multi-row/col selection leaves it alone, so the menu action applies
   * to the whole thing (e.g. "selecting 10 rows and doing insert below
   * inserts 10 rows," which needs the existing selection preserved, not
   * collapsed to just the row that happened to be right-clicked).
   */
  _onContextMenu(e) {
    const cellTdHit = e.target.closest('td');
    // A spacer <td> (see _renderWindow) has no dataset.ref -- treat it as
    // no cell hit, same as the guards on the mouse/touch handlers above.
    const cellTd = cellTdHit && cellTdHit.dataset.ref ? cellTdHit : null;
    const rowTh = e.target.closest('tbody th');
    const colTh = e.target.closest('thead th');
    if (!cellTd && !rowTh && !colTh) return;

    // One-shot escape hatch to the native browser menu (Fernando: "show an
    // option to show the normal browser right click menu"). Once
    // preventDefault() has been called on a contextmenu event there's no
    // way to un-suppress the native menu for that click -- browsers also
    // don't let scripts summon it on demand -- so this can only work by
    // arming a flag (see allowNativeContextMenuOnce()) that skips
    // preventDefault()/the custom menu for the *next* right-click instead.
    // Same pattern Google Docs/Sheets and VS Code web use for this. Always
    // consumed here regardless of outcome, so it can never stay armed past
    // one right-click (a timer in allowNativeContextMenuOnce() is the
    // backstop for "never right-clicks again").
    if (this._allowNativeContextMenuOnce) {
      this._allowNativeContextMenuOnce = false;
      clearTimeout(this._allowNativeContextMenuTimer);
      return;
    }

    e.preventDefault();

    let detail;
    if (cellTd) {
      const ref = cellTd.dataset.ref;
      const withinSelection = this.anchor && this.selected && this._rangeRefs(this.anchor, this.selected).includes(ref);
      if (!withinSelection) this._select(ref, false);
      detail = { kind: 'cell', x: e.clientX, y: e.clientY };
    } else if (rowTh) {
      const rowIndex = Number(rowTh.dataset.rowIndex);
      const range = this._selectedWholeRowRange();
      if (!range || rowIndex < range.start || rowIndex > range.end) this.selectWholeRow(rowIndex, false);
      detail = { kind: 'row-header', rowIndex, x: e.clientX, y: e.clientY };
    } else {
      const colIndex = Number(colTh.dataset.colIndex);
      const range = this._selectedWholeColRange();
      if (!range || colIndex < range.start || colIndex > range.end) this.selectWholeColumn(colIndex, false);
      detail = { kind: 'col-header', colIndex, x: e.clientX, y: e.clientY };
    }
    this.container.dispatchEvent(new CustomEvent('gridcontextmenu', { detail }));
  }

  /**
   * Arms the one-shot native-context-menu pass-through consumed by
   * _onContextMenu above. A 4s timer is the backstop for "user never
   * right-clicks again" (e.g. they left-click elsewhere, or just walk
   * away) -- without it the flag could sit armed indefinitely and
   * surprise them by silently swallowing a custom menu much later. Safe
   * to call again while already armed (just re-arms the timer).
   */
  allowNativeContextMenuOnce() {
    this._allowNativeContextMenuOnce = true;
    clearTimeout(this._allowNativeContextMenuTimer);
    this._allowNativeContextMenuTimer = setTimeout(() => {
      this._allowNativeContextMenuOnce = false;
    }, 4000);
  }

  /**
   * Row/column header click selects the whole row/column -- represented
   * with the exact same anchor/selected rectangle mechanism as a plain
   * cell-range selection (anchor = one edge of the row/column, selected =
   * the other), not a separate selection mode. This is what lets every
   * existing range-based operation (copy, clear, format, and the
   * multi-row/col insert-count logic below) work on a whole-row/column
   * selection for free, with no special-casing anywhere else.
   *
   * extend=true (drag across headers, or shift-click) grows the range from
   * the ORIGINAL anchor row/col to rowIndex/colIndex, keeping that anchor
   * fixed -- not a plain re-select -- so dragging from row 3 to row 7
   * selects rows 3-7, not just re-picks row 7 each time.
   */
  selectWholeRow(rowIndex, extend) {
    if (this.editingInput) this._commitEdit();
    // extend=false (a fresh click, or the mousedown that starts a drag)
    // re-anchors here; extend=true (shift-click, or every mousemove tick
    // during that same drag) keeps whatever anchor was already set, so a
    // drag from row 3 to row 7 selects rows 3-7, not just re-picks row 7
    // each tick.
    if (!extend || this._headerAnchorRow === null || this._headerAnchorRow === undefined) {
      this._headerAnchorRow = rowIndex;
    }
    const lastCol = colLetter(this.cols - 1);
    this.anchor = 'A' + (this._headerAnchorRow + 1);
    this.selected = lastCol + (rowIndex + 1);
    // Vertical scroll only -- `this.selected` here is the far-right column
    // of the row, not a meaningful horizontal target (a whole-row selection
    // has no single "correct" horizontal scroll position); `rowIndex` is
    // what actually needs to be visible.
    this._scrollRowIntoView(rowIndex);
    this._highlightRange(this.anchor, this.selected);
    if (this.onSelectionChange) this.onSelectionChange(this.selected);
  }

  selectWholeColumn(colIndex, extend) {
    if (this.editingInput) this._commitEdit();
    if (!extend || this._headerAnchorCol === null || this._headerAnchorCol === undefined) {
      this._headerAnchorCol = colIndex;
    }
    this.anchor = colLetter(this._headerAnchorCol) + '1';
    this.selected = colLetter(colIndex) + this.rows;
    // Horizontal scroll only -- see selectWholeRow's comment above (same
    // reasoning, transposed).
    this._scrollColIntoView(colIndex);
    this._highlightRange(this.anchor, this.selected);
    if (this.onSelectionChange) this.onSelectionChange(this.selected);
  }

  _onRowHeaderMouseDown(e, rowIndex) {
    if (e.button !== 0) return; // right-click is handled by _onContextMenu, don't also start a drag-select
    e.preventDefault();
    this._headerDragging = 'row';
    this._lastPointerXY = { x: e.clientX, y: e.clientY };
    this._startDragAutoScroll();
    this.selectWholeRow(rowIndex, e.shiftKey);
  }

  _onColHeaderMouseDown(e, colIndex) {
    if (e.button !== 0) return;
    e.preventDefault();
    this._headerDragging = 'col';
    this._lastPointerXY = { x: e.clientX, y: e.clientY };
    this._startDragAutoScroll();
    this.selectWholeColumn(colIndex, e.shiftKey);
  }

  /**
   * Touch counterpart of mousedown+mousemove drag-select (cell range, and
   * row/col header multi-select below). Can't just mirror mousedown/
   * mousemove directly: a finger dragging across the grid is ALSO how you
   * scroll it, and there's no way to tell "starting a range-select" apart
   * from "starting a scroll" from touchstart position/movement alone --
   * both begin as a finger moving across cells. Real spreadsheet apps
   * (Google Sheets/Excel mobile) resolve this the same way: a plain swipe
   * scrolls; a finger held still for a beat first, THEN dragged, means
   * "I'm selecting a range." Implemented here as a short arm-timer: touchstart
   * records where/what was touched but does nothing yet (no preventDefault,
   * so a normal scroll starts immediately if that's what the gesture turns
   * out to be); if the timer fires before real movement happens, NOW commit
   * to drag-select (same _select/selectWholeRow/selectWholeColumn calls the
   * mouse path uses) and start blocking the browser's scroll for the rest of
   * this gesture; if movement arrives first, it's a scroll -- cancel the
   * timer and never engage for this gesture. A plain tap (no movement, timer
   * never even relevant) is untouched by any of this -- it already works via
   * the browser's own tap-to-mousedown/mouseup/click synthesis, which this
   * code doesn't interfere with since touchstart never calls preventDefault.
   */
  _onTouchStart(e) {
    if (e.touches.length !== 1) return; // ignore pinch-zoom/multi-touch entirely
    if (e.target.closest('.col-resize-handle') || e.target.closest('.row-resize-handle')) return;
    const td = e.target.closest('td');
    // See _onMouseDown's comment -- a spacer <td> has no dataset.ref.
    if (!td || !td.dataset.ref) return;
    const touch = e.touches[0];
    this._armTouchDragCandidate({ kind: 'cell', ref: td.dataset.ref }, touch);
  }

  _onRowHeaderTouchStart(e, rowIndex) {
    if (e.touches.length !== 1) return;
    // Unlike _onMouseDown/_onTouchStart's resize-handle guards, this does
    // NOT bail out when the touch lands on .row-resize-handle: that span
    // has no touchstart listener of its own (resize is mouse-drag-only,
    // see _rowResizeHandle), so a real touch there would otherwise be
    // silently swallowed instead of drag-selecting the row it visually
    // sits inside -- Chrome's real touch hit-testing (distinct from
    // elementFromPoint) routes touches near a header's trailing edge to
    // this thin handle even though _onRowHeaderTouchStart is what's
    // listening on the <th> itself. Since there's no competing
    // touch-resize feature to protect, treat it the same as any other
    // touch on the header. See BUGS_FOUND.md [037].
    this._armTouchDragCandidate({ kind: 'row', index: rowIndex }, e.touches[0]);
  }

  _onColHeaderTouchStart(e, colIndex) {
    if (e.touches.length !== 1) return;
    // See _onRowHeaderTouchStart's comment above (same reasoning,
    // transposed to .col-resize-handle).
    this._armTouchDragCandidate({ kind: 'col', index: colIndex }, e.touches[0]);
  }

  _armTouchDragCandidate(candidate, touch) {
    if (this._touchDragTimer) clearTimeout(this._touchDragTimer);
    if (this._touchLongPressTimer) clearTimeout(this._touchLongPressTimer);
    this._touchDragCandidate = { ...candidate, x: touch.clientX, y: touch.clientY, armed: false };
    this._touchDragTimer = setTimeout(() => {
      const c = this._touchDragCandidate;
      if (!c) return;
      c.armed = true;
      this._lastPointerXY = { x: c.x, y: c.y };
      this._startDragAutoScroll();
      if (c.kind === 'cell') {
        this._dragging = true;
        this._select(c.ref, false);
      } else if (c.kind === 'row') {
        this._headerDragging = 'row';
        this.selectWholeRow(c.index, false);
      } else if (c.kind === 'col') {
        this._headerDragging = 'col';
        this.selectWholeColumn(c.index, false);
      }
    }, TOUCH_DRAG_ARM_MS);
    // Long-press-to-context-menu: a separate, longer timer racing the
    // drag-arm one above. If the finger is still down and hasn't moved at
    // all by this point, treat it as a deliberate long-press and open the
    // same context menu the mouse contextmenu path opens (see
    // _onContextMenu/app.js's 'gridcontextmenu' listener). Any real
    // movement -- either before the drag-arm timer fires (see the "moved
    // > TOUCH_DRAG_ARM_PX" scroll-detection branch below, which clears
    // this timer too) or after it, once armed (a genuine drag-select) --
    // cancels this timer, so "long-press-then-drag" keeps today's
    // drag-select behavior instead of also popping a menu.
    this._touchLongPressTimer = setTimeout(() => {
      const c = this._touchDragCandidate;
      if (!c) return;
      this._openTouchContextMenu(c);
    }, TOUCH_LONG_PRESS_MENU_MS);
  }

  /**
   * Touch counterpart of _onContextMenu's dispatch, used by the long-press
   * gesture above. By the time this runs, the drag-arm timer (which always
   * fires first, since TOUCH_LONG_PRESS_MENU_MS > TOUCH_DRAG_ARM_MS) has
   * already selected the held cell/row/column via the same
   * _select/selectWholeRow/selectWholeColumn calls the mouse path uses, so
   * this only needs to build the same `detail` shape _onContextMenu does
   * and dispatch it -- app.js's listener doesn't know or care whether it
   * came from a right-click or a long-press. Clears the touch-drag state
   * so the eventual touchend doesn't also treat this as a released drag.
   *
   * Since touchstart/touchmove were never preventDefault()'d for this
   * still-held gesture (no movement happened, so _onTouchMove's armed
   * branch -- the only place that calls preventDefault -- never ran), the
   * browser still owes this touch its usual mouse-event-and-click
   * synthesis once the finger lifts. Left alone, that synthetic click
   * would land on the cell/header underneath (not the menu, which wasn't
   * there when the finger went down) and immediately close the
   * just-opened menu via its own click-outside handler (app.js's
   * showContextMenuAt) -- the menu would flash open and shut in one
   * gesture. Arming `_suppressNextTouchClick` here, consumed by
   * _onTouchEnd via preventDefault() on the touchend itself (which does
   * suppress that synthesis, per the touch-events spec), avoids that.
   */
  _openTouchContextMenu(c) {
    let detail;
    if (c.kind === 'row') {
      detail = { kind: 'row-header', rowIndex: c.index, x: c.x, y: c.y };
    } else if (c.kind === 'col') {
      detail = { kind: 'col-header', colIndex: c.index, x: c.x, y: c.y };
    } else {
      detail = { kind: 'cell', x: c.x, y: c.y };
    }
    this._touchDragCandidate = null;
    this._dragging = false;
    this._headerDragging = null;
    this._suppressNextTouchClick = true;
    if (this._touchDragTimer) {
      clearTimeout(this._touchDragTimer);
      this._touchDragTimer = null;
    }
    this.container.dispatchEvent(new CustomEvent('gridcontextmenu', { detail }));
  }

  _onTouchMove(e) {
    const c = this._touchDragCandidate;
    if (!c) return;
    if (e.touches.length !== 1) return;
    const touch = e.touches[0];
    if (!c.armed) {
      const moved = Math.hypot(touch.clientX - c.x, touch.clientY - c.y);
      if (moved > TOUCH_DRAG_ARM_PX) {
        // Moved before the arm-timer fired -- a scroll, not a range-select.
        // Don't preventDefault; let the browser scroll normally, and stop
        // tracking so a later pause-then-move in this same gesture can't
        // retroactively arm drag-select mid-scroll. Also cancels the
        // long-press-to-menu timer -- movement means this was never a
        // still long-press.
        clearTimeout(this._touchDragTimer);
        clearTimeout(this._touchLongPressTimer);
        this._touchDragCandidate = null;
      }
      return;
    }
    // Armed: a deliberate drag-select, not a scroll -- block the browser's
    // native scroll for the rest of this gesture. touchmove's own e.target
    // stays pinned to whatever touchstart hit (unlike mousemove, which
    // tracks the live element under the pointer), so elementFromPoint is
    // the only way to find what's actually under the finger right now.
    // This is also real movement, so cancel the long-press-to-menu timer:
    // a long-press that then drags keeps the existing drag-select
    // behavior rather than also popping the context menu.
    clearTimeout(this._touchLongPressTimer);
    e.preventDefault();
    this._lastPointerXY = { x: touch.clientX, y: touch.clientY };
    // See _resolveDragTarget's doc comment -- same sticky-header-overlay
    // hit-test problem applies to a touch drag as to a mouse one.
    const el = this._resolveDragTarget(c.kind === 'cell' ? 'cell' : c.kind, touch.clientX, touch.clientY);
    if (!el) return;
    if (c.kind === 'row') {
      const th = el.closest('tbody th');
      if (th && th.dataset.rowIndex !== undefined) this.selectWholeRow(Number(th.dataset.rowIndex), true);
    } else if (c.kind === 'col') {
      const th = el.closest('thead th');
      if (th && th.dataset.colIndex !== undefined) this.selectWholeColumn(Number(th.dataset.colIndex), true);
    } else {
      const td = el.closest('td');
      if (td && td.dataset.ref && td.dataset.ref !== this.selected) {
        this.selected = td.dataset.ref;
        this._highlightRange(this.anchor, this.selected);
        if (this.onSelectionChange) this.onSelectionChange(this.selected);
      }
    }
  }

  _onTouchEnd(e) {
    if (this._touchDragTimer) {
      clearTimeout(this._touchDragTimer);
      this._touchDragTimer = null;
    }
    if (this._touchLongPressTimer) {
      clearTimeout(this._touchLongPressTimer);
      this._touchLongPressTimer = null;
    }
    // See _openTouchContextMenu: swallow the mouse-event/click synthesis
    // this touch would otherwise still get, so the freshly-opened context
    // menu doesn't immediately close itself via its own click-outside
    // handler.
    if (this._suppressNextTouchClick) {
      this._suppressNextTouchClick = false;
      if (e && e.cancelable) e.preventDefault();
    }
    const c = this._touchDragCandidate;
    this._touchDragCandidate = null;
    if (!c || !c.armed) return;
    this._stopDragAutoScroll();
    if (this._headerDragging) {
      this._headerDragging = null;
      this.container.dispatchEvent(new CustomEvent('cellselect', { detail: { ref: this.selected } }));
      return;
    }
    if (this._dragging) {
      this._dragging = false;
      this.container.dispatchEvent(new CustomEvent('cellselect', { detail: { ref: this.selected } }));
    }
  }

  /**
   * Whether the current selection IS a whole-row(s) selection (spans every
   * column, A through the last one) -- used both to highlight/represent
   * multi-row header selections and to size an insert/delete triggered
   * from the row-header context menu ("selecting 10 rows and doing insert
   * below inserts 10 rows" -- see showHeaderContextMenu in app.js).
   * @returns {{start: number, end: number}|null} 0-indexed, inclusive.
   */
  _selectedWholeRowRange() {
    if (!this.anchor || !this.selected) return null;
    const pa = parseRef(this.anchor), ps = parseRef(this.selected);
    if (pa.col !== 0 || ps.col !== this.cols - 1) return null;
    return { start: Math.min(pa.row, ps.row), end: Math.max(pa.row, ps.row) };
  }

  /** Column counterpart of _selectedWholeRowRange -- spans every row, top to bottom. */
  _selectedWholeColRange() {
    if (!this.anchor || !this.selected) return null;
    const pa = parseRef(this.anchor), ps = parseRef(this.selected);
    if (pa.row !== 0 || ps.row !== this.rows - 1) return null;
    return { start: Math.min(pa.col, ps.col), end: Math.max(pa.col, ps.col) };
  }

  _select(ref, extend) {
    if (this.editingInput) this._commitEdit();
    this.anchor = extend && this.anchor ? this.anchor : ref;
    this.selected = ref;
    // Scroll BEFORE highlighting -- a newly-selected ref reached via
    // keyboard traversal (_moveSelection) or programmatic selection
    // (_onContainerFocus) is routinely off-screen under windowing, with no
    // live <td> yet; _scrollRefIntoView mounts it (via _renderWindow) if a
    // scroll was actually needed, so _highlightRange right after has a
    // real element to add .selected to instead of silently no-op'ing.
    this._scrollRefIntoView(ref);
    this._highlightRange(this.anchor, this.selected);
    this.container.dispatchEvent(new CustomEvent('cellselect', { detail: { ref } }));
    if (this.onSelectionChange) this.onSelectionChange(ref);
  }

  _highlightRange(a, b) {
    this.table.querySelectorAll('td.selected').forEach((el) => el.classList.remove('selected'));
    for (const ref of this._rangeRefs(a, b)) {
      const el = this._cellEl(ref);
      if (el) el.classList.add('selected');
    }
  }

  /**
   * Clears any current cell/range selection -- same end state as if
   * nothing had ever been selected. Used by the blank corner header
   * cell's click handler (see _build()); factored out rather than inlined
   * there so it stays in the same neighborhood as _select/_highlightRange
   * and picks up any future changes to what "selected" means.
   */
  _deselectAll() {
    if (this.editingInput) this._commitEdit();
    this.anchor = null;
    this.selected = null;
    this.table.querySelectorAll('td.selected').forEach((el) => el.classList.remove('selected'));
    this.container.dispatchEvent(new CustomEvent('cellselect', { detail: { ref: null } }));
    if (this.onSelectionChange) this.onSelectionChange(null);
  }

  _rangeRefs(a, b) {
    const pa = parseRef(a);
    const pb = parseRef(b);
    const refs = [];
    for (let r = Math.min(pa.row, pb.row); r <= Math.max(pa.row, pb.row); r++) {
      for (let c = Math.min(pa.col, pb.col); c <= Math.max(pa.col, pb.col); c++) {
        refs.push(colLetter(c) + (r + 1));
      }
    }
    return refs;
  }

  /** Same rectangle, minus cells that are merge-covered (no independent identity to format/merge/copy). */
  _visibleRangeRefs(a, b) {
    return this._rangeRefs(a, b).filter((ref) => !this._isCovered(ref));
  }

  _beginEdit(ref) {
    if (this.readOnly || this._isCovered(ref)) return;
    const el = this._cellEl(ref);
    if (!el) return;
    const current = (this.cells[ref] && this.cells[ref].value) || '';
    el.textContent = '';
    const input = document.createElement('input');
    input.type = 'text';
    input.value = current;
    input.className = 'cell-input';
    el.appendChild(input);
    input.focus();
    input.select();
    this.editingInput = { ref, input };

    input.addEventListener('blur', () => this._commitEdit());
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this._commitEdit();
        this._moveSelection(0, 1);
      } else if (e.key === 'Escape') {
        this.editingInput = null;
        this._renderCell(ref);
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        // Unlike Left/Right, a single-line input has no vertical cursor
        // position to preserve -- always commit and move, no boundary check.
        e.preventDefault();
        this._commitEdit();
        this._moveSelection(0, e.key === 'ArrowUp' ? -1 : 1);
      } else if (e.key === 'ArrowLeft' && input.selectionStart === 0 && input.selectionEnd === 0) {
        e.preventDefault();
        this._commitEdit();
        this._moveSelection(-1, 0);
      } else if (e.key === 'ArrowRight' && input.selectionStart === input.value.length && input.selectionEnd === input.value.length) {
        e.preventDefault();
        this._commitEdit();
        this._moveSelection(1, 0);
      } else {
        // Not a key we're intercepting -- most commonly Left/Right with the
        // cursor mid-field, which should just move the cursor within the
        // input normally. Returning here (skipping stopPropagation below)
        // matters: preventDefault/stopPropagation on every keydown would
        // otherwise block that native behavior too.
        return;
      }
      e.stopPropagation();
    });
  }

  _commitEdit() {
    if (!this.editingInput) return;
    const { ref, input } = this.editingInput;
    const value = input.value;
    this.editingInput = null;
    this.setCellValue(ref, value);
  }

  /**
   * Sets a cell's raw value (literal or "=formula") -- shared by in-cell
   * editing, the formula bar, paste, and ACTIONGROUP's action execution,
   * so anything that changes a cell's value goes through one place.
   *
   * If `ref` is a saveOnEdit target of some USERINFO action elsewhere on
   * the sheet (see _buildActionGroupWatches), this also re-syncs that
   * field's cookie/DB value -- deliberately only for a LOCAL commit (this
   * is the only caller of setCellValue -- applyRemote's non-structural
   * cell branch updates this.cells directly and never calls this), since a
   * value a *different* viewer typed shouldn't get saved into THIS
   * viewer's own remembered info just because their browser received the
   * resulting WS patch.
   */
  setCellValue(ref, value) {
    if (this.readOnly || this._isCovered(ref)) return;
    const prev = this.cells[ref] || {};
    if (value === '') {
      delete this.cells[ref];
      this.onChange({ cells: { [ref]: null } });
      const watch = this._buildActionGroupWatches().get(ref);
      if (watch) deleteUserInfoField(watch.infoType);
    } else {
      this.cells[ref] = { ...prev, value };
      this.onChange({ cells: { [ref]: { value } } });
      const watch = this._buildActionGroupWatches().get(ref);
      if (watch) setUserInfoField(watch.infoType, value);
    }
    this._renderCell(ref);
    this._recalcDependents([ref]);
  }

  _onKeyDown(e) {
    if (this.editingInput || !this.selected) return;
    if (this._keyboardShouldDeferToOtherControl()) return;
    // A modal (e.g. formula help) has no focusable input for the check
    // above to catch, but the grid underneath still shouldn't react to
    // Delete/Ctrl+C/etc. while one is open -- see _isModalOpen().
    if (this._isModalOpen()) return;

    const moves = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };
    if (moves[e.key]) {
      e.preventDefault();
      this._moveSelection(...moves[e.key]);
    } else if (e.key === 'Enter' || e.key === 'F2') {
      e.preventDefault();
      this._beginEdit(this.selected);
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      this._clearSelection();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
      // The native 'copy' event (see _onCopy below) only fires when there's
      // an actual browser text/DOM selection, which clicking a cell never
      // creates here -- Ctrl+C otherwise silently does nothing. Handle it
      // directly instead of relying on that event. But if the user genuinely
      // selected text elsewhere on the page (e.g. dragging over a dialog's
      // text -- the modal check above already covers that case, this also
      // covers any non-modal selectable text), let the browser's own copy
      // proceed instead of overwriting the clipboard with cell data.
      if (this._hasExternalTextSelection()) return;
      e.preventDefault();
      this._copySelectionToClipboard();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') {
      if (this.readOnly) return;
      e.preventDefault();
      this._pasteClipboardAtSelection();
    } else if (!this.readOnly && e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
      this._beginEdit(this.selected);
      this.editingInput.input.value = '';
    }
  }

  /** Merged cell landed on by keyboard navigation redirects to its origin -- there's nothing else there to select. */
  _moveSelection(dc, dr) {
    const p = parseRef(this.selected);
    let col = Math.min(this.cols - 1, Math.max(0, p.col + dc));
    let row = Math.min(this.rows - 1, Math.max(0, p.row + dr));
    let ref = colLetter(col) + (row + 1);
    if (this._isCovered(ref)) {
      const origin = this._originOf(ref);
      if (origin) ref = origin;
    }
    this._select(ref, false);
  }

  _originOf(coveredRef) {
    for (const [ref, cell] of Object.entries(this.cells)) {
      if (!cell || !cell.merge) continue;
      const { row, col } = parseRef(ref);
      const p = parseRef(coveredRef);
      if (p.row >= row && p.row < row + cell.merge.rows && p.col >= col && p.col < col + cell.merge.cols) {
        return ref;
      }
    }
    return null;
  }

  // Tab-separated between columns, newline-separated between rows -- the
  // de facto interchange format spreadsheet apps use for clipboard data,
  // so this round-trips with pasting into/from a real spreadsheet app.
  _selectionToTsv() {
    const refs = this._visibleRangeRefs(this.anchor, this.selected);
    const rows = {};
    for (const ref of refs) {
      const { row } = parseRef(ref);
      (rows[row] = rows[row] || []).push((this.cells[ref] && this.cells[ref].value) || '');
    }
    return Object.keys(rows).sort((a, b) => a - b).map((r) => rows[r].join('\t')).join('\n');
  }

  // Routes through setCellValue() (used to inline the same three lines
  // directly) so paste picks up the saveOnEdit watch hook there for free
  // instead of silently bypassing it -- pasting a new value into a watched
  // cell is still "editing that cell going forward" per CELL_SCHEMA.md's
  // ACTIONGROUP/USERINFO semantics, same as typing or the formula bar.
  //
  // origin (optional): the top-left {col,row} of where this TSV was
  // originally copied FROM. When known, a pasted formula value has its
  // references shifted by (pasteTarget - origin) via
  // shiftFormulaReferences() -- see CELL_SCHEMA.md's "$ locking" section.
  // Unknown (paste from outside the app, or the Clipboard API round-trip
  // couldn't confirm it's our own last copy) means formulas paste
  // literally, unchanged -- the pre-existing behavior, not a regression.
  // Writes every pasted cell directly (not via setCellValue() per cell) and
  // rebuilds the ACTIONGROUP-watch map and dependents graph exactly ONCE
  // for the whole paste, not once per pasted cell -- see BUGS_FOUND.md
  // [019]/[020]: going through setCellValue() per cell made every single
  // pasted cell independently pay for a full O(total sheet cells)
  // _buildActionGroupWatches() scan and another full O(total sheet cells)
  // _buildDependents() scan (via _recalcDependents()), turning an
  // O(pasted cells) paste into O(pasted cells x total sheet cells) -- a
  // multi-second full-tab freeze on a real-world-scale sheet. Mirrors the
  // batching _clearSelection() already does for its own range (build
  // watches once before the loop, call _recalcDependents() once after).
  _applyTsvAtSelection(text, origin) {
    if (!text || this.readOnly) return;
    const startCell = parseRef(this.selected);
    const deltaCols = origin ? startCell.col - origin.col : 0;
    const deltaRows = origin ? startCell.row - origin.row : 0;
    const lines = text.replace(/\r/g, '').split('\n').filter((l, i, a) => !(i === a.length - 1 && l === ''));
    const writes = [];
    lines.forEach((line, r) => {
      line.split('\t').forEach((value, c) => {
        const ref = colLetter(startCell.col + c) + (startCell.row + r + 1);
        if (value === '' || this._isCovered(ref)) return;
        const toWrite = origin && isFormula(value) ? shiftFormulaReferences(value, deltaCols, deltaRows) : value;
        writes.push([ref, toWrite]);
      });
    });
    if (!writes.length) return;
    const watches = this._buildActionGroupWatches();
    const changedRefs = [];
    for (const [ref, value] of writes) {
      const prev = this.cells[ref] || {};
      this.cells[ref] = { ...prev, value };
      this.onChange({ cells: { [ref]: { value } } });
      const watch = watches.get(ref);
      if (watch) setUserInfoField(watch.infoType, value);
      this._renderCell(ref);
      changedRefs.push(ref);
    }
    this._recalcDependents(changedRefs);
  }

  // Ctrl/Cmd+C path (see _onKeyDown): writes to the real OS clipboard via
  // the async Clipboard API when available (requires a secure context --
  // true in production, not necessarily true under local http:// dev),
  // and always to the in-app fallback so copy/paste still works within
  // the app regardless. Also records the copy's origin corner (see
  // _applyTsvAtSelection) so a same-app paste can shift formula refs.
  _copySelectionToClipboard() {
    if (!this.selected || this.editingInput) return;
    const tsv = this._selectionToTsv();
    this._internalClipboard = tsv;
    const pa = parseRef(this.anchor), ps = parseRef(this.selected);
    this._internalClipboardOrigin = { col: Math.min(pa.col, ps.col), row: Math.min(pa.row, ps.row) };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(tsv).catch(() => {
        /* OS clipboard unavailable/denied -- in-app fallback above still covers it */
      });
    }
  }

  _pasteClipboardAtSelection() {
    if (!this.selected || this.editingInput) return;
    if (navigator.clipboard && navigator.clipboard.readText) {
      navigator.clipboard.readText()
        .then((text) => {
          // Used to require `text === this._internalClipboard` before
          // trusting the origin -- but the writeText() in
          // _copySelectionToClipboard() is async/best-effort with no
          // ordering guarantee against this readText(), so a Ctrl+C then
          // immediate Ctrl+V (the normal way anyone copy/pastes) could read
          // back empty/stale content before the write lands, silently
          // failing that equality check and disabling ref-shifting on every
          // same-app paste -- confirmed live, not hypothetical. An empty
          // read is exactly what that race produces, not what genuinely
          // different external clipboard content looks like (a real
          // external copy is essentially never literally ''), so treat
          // empty the same as a match: trust our own in-memory origin. Only
          // a non-empty read that actually differs from our last copy means
          // the clipboard now holds something else (switched apps, copied
          // something else) -- that's the one case with no known origin.
          const origin = (!text || text === this._internalClipboard) ? this._internalClipboardOrigin : undefined;
          this._applyTsvAtSelection(text || this._internalClipboard, origin);
        })
        .catch(() => this._applyTsvAtSelection(this._internalClipboard, this._internalClipboardOrigin));
    } else {
      this._applyTsvAtSelection(this._internalClipboard, this._internalClipboardOrigin);
    }
  }

  /**
   * Removes value+format+merge from every visible cell in the selection
   * (a right-click "Clear contents" or Delete/Backspace) -- shared by
   * _onKeyDown's Delete handler and the cell context menu (see
   * showCellContextMenu in app.js) so there's one place that decides what
   * "clearing a cell" means, not two copies that could drift.
   *
   * Also deletes a cleared cell's saveOnEdit cookie/localStorage if it's a
   * watched USERINFO target -- Fernando: "when I clear a userinfo cells
   * contents, I want the cookie deleted, including name." Reversed from
   * this method's original behavior (leaving the cookie alone, reasoned as
   * "don't erase their remembered email/name just because they cleared one
   * cell that happened to display it") -- his explicit call, and it makes
   * clearing symmetric with typing: setCellValue()'s own empty-string
   * branch does the same deleteUserInfoField() now, so a watched cell's
   * cookie always matches what's on screen, blank included.
   *
   * EXCEPT when the ACTIONGROUP that owns the watch is ALSO in this same
   * cleared range (e.g. deleting the whole row a button lives in, target
   * cell included) -- Fernando: "deleting a row, or deleting the
   * actiongroup cell should prevent this behavior, because the cell with
   * the actiongroup is gone." The watch relationship is being dissolved
   * entirely here, not "someone cleared a value while the button is still
   * live and watching," so no cookie gets touched. Building the full
   * to-be-cleared set up front (rather than checking this.cells mid-loop)
   * makes this independent of iteration order -- the source cell may or
   * may not have been deleted from this.cells yet by the time its target
   * is reached.
   */
  _clearSelection() {
    if (this.readOnly || !this.anchor || !this.selected) return;
    const refs = this._visibleRangeRefs(this.anchor, this.selected).filter((ref) => this.cells[ref]);
    if (!refs.length) return;
    const refsBeingCleared = new Set(refs);
    const watches = this._buildActionGroupWatches();
    for (const ref of refs) {
      delete this.cells[ref];
      this.onChange({ cells: { [ref]: null } });
      this._renderCell(ref);
      const watch = watches.get(ref);
      if (watch && !refsBeingCleared.has(watch.sourceRef)) deleteUserInfoField(watch.infoType);
    }
    this._recalcDependents(refs);
  }

  /** Right-click "Cut": copy, then clear -- same two operations Ctrl+X would do if this app bound that shortcut. */
  _cutSelectionToClipboard() {
    this._copySelectionToClipboard();
    this._clearSelection();
  }

  // Native copy/paste events: only fire given an actual browser
  // text/DOM selection or focus in an editable element, which plain cell
  // clicks never create here -- so in practice these rarely trigger. Kept as a
  // secondary path (e.g. a real text selection made some other way);
  // Ctrl+C/V is handled directly in _onKeyDown, which is what actually
  // works from a plain cell click.
  _onCopy(e) {
    if (this._hasExternalTextSelection() || this._isModalOpen()) return;
    if (!this.selected || this.editingInput) return;
    if (this._keyboardShouldDeferToOtherControl()) return;
    e.clipboardData.setData('text/plain', this._selectionToTsv());
    e.preventDefault();
  }

  _onPaste(e) {
    if (this._isModalOpen()) return;
    if (this.readOnly || !this.selected || this.editingInput) return;
    if (this._keyboardShouldDeferToOtherControl()) return;
    const text = e.clipboardData.getData('text/plain');
    if (!text) return;
    e.preventDefault();
    this._applyTsvAtSelection(text);
  }

  applyFormatToSelection(format) {
    if (this.readOnly || !this.selected) return;
    for (const ref of this._visibleRangeRefs(this.anchor, this.selected)) {
      const prev = this.cells[ref] || {};
      const nextFormat = { ...(prev.format || {}), ...format };
      this.cells[ref] = { ...prev, format: nextFormat };
      this.onChange({ cells: { [ref]: { format: nextFormat } } });
      this._renderCell(ref);
    }
  }

  /**
   * Current selection's format, merged across every visible cell in the
   * range (not just the anchor) -- lets the toolbar show/toggle current
   * state instead of blindly forcing bold/italic/etc. on. For each format
   * key present on any cell, returns the shared value if every cell in the
   * selection agrees (including cells with no explicit value for that key,
   * which count as `undefined`), or FORMAT_MIXED if they don't.
   */
  getSelectionFormat() {
    if (!this.anchor) return {};
    const refs = this._visibleRangeRefs(this.anchor, this.selected);
    if (!refs.length) return {};
    const formats = refs.map((ref) => (this.cells[ref] && this.cells[ref].format) || {});
    const keys = new Set();
    formats.forEach((f) => Object.keys(f).forEach((k) => keys.add(k)));
    const result = {};
    for (const key of keys) {
      const values = formats.map((f) => f[key]);
      result[key] = values.every((v) => v === values[0]) ? values[0] : FORMAT_MIXED;
    }
    return result;
  }

  // Standard toggle convention: only "on" (true, non-mixed) for every cell
  // in the selection turns it off; anything else (some/all off, or a mixed
  // selection) turns it on for all -- avoids silently un-toggling cells
  // that never had the anchor's state to begin with.
  toggleFormatOnSelection(key) {
    const current = this.getSelectionFormat()[key] === true;
    this.applyFormatToSelection({ [key]: !current });
  }

  /**
   * Merge the selected range into its top-left cell. Refuses (returns
   * {ok:false}) if the range is a single cell, if any cell in it is
   * already part of another merge, or if any NON-origin cell has content
   * -- simplest, safest choice: never silently discard data. The caller
   * (app.js) surfaces the error; grid.js has no dialog/toast machinery of
   * its own.
   */
  mergeSelection() {
    if (this.readOnly || !this.anchor || !this.selected) return { ok: false, error: 'Nothing selected' };
    const refs = this._rangeRefs(this.anchor, this.selected);
    if (refs.length < 2) return { ok: false, error: 'Select more than one cell to merge' };
    // See _captureScrollAnchor's doc comment -- merging doesn't change
    // this.rows/this.cols at all, so no index remap is needed on restore.
    const scrollAnchor = this._captureScrollAnchor();

    const pa = parseRef(this.anchor);
    const pb = parseRef(this.selected);
    const originCol = Math.min(pa.col, pb.col);
    const originRow = Math.min(pa.row, pb.row);
    const origin = colLetter(originCol) + (originRow + 1);
    const cols = Math.abs(pa.col - pb.col) + 1;
    const rows = Math.abs(pa.row - pb.row) + 1;

    for (const ref of refs) {
      if (this._isCovered(ref) || (this.cells[ref] && this.cells[ref].merge && ref !== origin)) {
        return { ok: false, error: 'Selection overlaps an existing merged cell' };
      }
      if (ref !== origin && this.cells[ref] && this.cells[ref].value) {
        return { ok: false, error: 'Merging would discard content in a non-origin cell -- clear it first' };
      }
    }

    for (const ref of refs) {
      if (ref === origin) continue;
      if (this.cells[ref]) {
        delete this.cells[ref];
        this.onChange({ cells: { [ref]: null } });
      }
    }
    const prev = this.cells[origin] || {};
    this.cells[origin] = { ...prev, merge: { rows, cols } };
    this.onChange({ cells: { [origin]: { merge: { rows, cols } } } });
    this._build();
    this._restoreScrollAnchor(scrollAnchor);
    return { ok: true };
  }

  unmergeSelection() {
    if (this.readOnly || !this.selected) return { ok: false, error: 'Nothing selected' };
    const origin = this._isCovered(this.selected) ? this._originOf(this.selected) : this.selected;
    if (!origin || !this.cells[origin] || !this.cells[origin].merge) {
      return { ok: false, error: 'Selection is not a merged cell' };
    }
    // See mergeSelection's comment -- unmerging doesn't renumber rows/cols either.
    const scrollAnchor = this._captureScrollAnchor();
    const { merge, ...rest } = this.cells[origin];
    this.cells[origin] = rest;
    this.onChange({ cells: { [origin]: { merge: null } } });
    this._build();
    this._restoreScrollAnchor(scrollAnchor);
    return { ok: true };
  }

  // --- Structural insert/delete row/column ---------------------------
  //
  // Public entry points (called from app.js's header context menu, see
  // showHeaderContextMenu): insertRowsAt/deleteRowsAt/insertColumnsAt/
  // deleteColumnsAt. boundaryIndex is always 0-indexed. insert means
  // "count new rows/columns appear starting AT boundaryIndex, pushing
  // whatever was there down/right"; delete means "count rows/columns
  // starting AT boundaryIndex are removed." Both funnel through
  // _transformStructure, which does the actual cell/columnWidths/
  // rowHeights remapping and formula-reference fixup, then emits one
  // onChange patch and rebuilds.

  insertRowsAt(boundaryIndex, count) {
    if (this.readOnly || count < 1) return;
    this._transformStructure('row', boundaryIndex, count, true);
  }

  insertColumnsAt(boundaryIndex, count) {
    if (this.readOnly || count < 1) return;
    this._transformStructure('col', boundaryIndex, count, true);
  }

  /** Clamps count so at least MIN_ROWS survives -- never delete a grid down to zero rows. */
  deleteRowsAt(boundaryIndex, count) {
    if (this.readOnly || count < 1) return;
    const clamped = Math.min(count, Math.max(0, this.rows - MIN_ROWS));
    if (clamped < 1) return;
    this._transformStructure('row', boundaryIndex, clamped, false);
  }

  deleteColumnsAt(boundaryIndex, count) {
    if (this.readOnly || count < 1) return;
    const clamped = Math.min(count, Math.max(0, this.cols - MIN_COLS));
    if (clamped < 1) return;
    this._transformStructure('col', boundaryIndex, clamped, false);
  }

  /**
   * Core structural transform shared by all four insert/delete methods
   * above.
   *
   * 1. Rebuilds `this.cells` from scratch: every surviving cell's
   *    position is remapped (shifted if at/after boundaryIndex, removed
   *    if it falls inside a deleted range), AND -- independently of
   *    whether that particular cell's own position changed -- any formula
   *    VALUE is passed through shiftReferencesForStructuralChange() (see
   *    formulas.js), since a cell that didn't move can still reference
   *    one that did. This is a best-effort formula-reference fixup, not
   *    full dependency-graph correctness -- see that function's doc
   *    comment for exactly what it does and doesn't handle.
   * 2. Remaps columnWidths/rowHeights' sparse override keys the same way.
   * 3. Updates this.cols/this.rows.
   * 4. Builds ONE merge-patch covering all of the above (every vacated
   *    old position nulled, every occupied new position set -- see
   *    _diffKeyedMap) and emits it via onChange, then rebuilds.
   */
  _transformStructure(dimension, boundaryIndex, count, isInsert) {
    // Captured before anything below mutates this.rows/this.cols/
    // rowHeights/columnWidths -- see _captureScrollAnchor's doc comment
    // for why the raw scrollTop/scrollLeft alone can't just be replayed
    // back unchanged after _build() runs. Unlike merge/unmerge (which
    // never renumber rows/cols), an insert/delete here genuinely shifts
    // indices around -- the remap below (mirroring the same idx ->
    // newIdx logic this function already applies to every cell position)
    // accounts for that, so a user scrolled past the boundary lands back
    // on the SAME content, not just the same raw pixel offset (which would
    // now show different rows/columns after the shift).
    const scrollAnchor = this._captureScrollAnchor();
    const remapIndex = (idx) => this._remapStructuralIndex(idx, boundaryIndex, count, isInsert);
    const newCells = {};
    for (const [ref, cell] of Object.entries(this.cells)) {
      const p = parseRef(ref);
      const idx = dimension === 'row' ? p.row : p.col;
      if (!isInsert && idx >= boundaryIndex && idx < boundaryIndex + count) continue; // this cell is being deleted

      let newIdx = idx;
      if (isInsert) {
        if (idx >= boundaryIndex) newIdx = idx + count;
      } else if (idx >= boundaryIndex + count) {
        newIdx = idx - count;
      }
      const newRow = dimension === 'row' ? newIdx : p.row;
      const newCol = dimension === 'col' ? newIdx : p.col;
      const newRef = colLetter(newCol) + (newRow + 1);

      let newCell = cell;
      if (cell && isFormula(cell.value)) {
        // ACTIONGROUP gets its own shifter -- see shiftActionGroupReferences()'s
        // doc comment for why the generic whole-formula-to-#REF! behavior
        // below is wrong for it (drops one dead action, not the whole button).
        const shifted = parseActionGroup(cell.value)
          ? shiftActionGroupReferences(cell.value, dimension, boundaryIndex, count, isInsert)
          : shiftReferencesForStructuralChange(cell.value, dimension, boundaryIndex, count, isInsert);
        if (shifted !== cell.value) newCell = { ...cell, value: shifted };
      }

      // A merge origin whose span (in this dimension) straddles the
      // boundary needs its own size adjusted, independently of whether
      // the origin's position moved -- otherwise an insert inside the
      // span gets silently swallowed (span too small, covers one row/col
      // short) or a delete inside the span leaves the merge claiming
      // cells it no longer has (span too big, hiding whatever now sits
      // underneath it -- _isCovered()/_build() would still treat that ref
      // as covered and never render a <td> for it). Boundaries strictly
      // before or after the span are untouched here; only the shift above
      // applies to those, matching pre-existing behavior.
      if (cell && cell.merge) {
        const span = dimension === 'row' ? cell.merge.rows : cell.merge.cols;
        let newSpan = span;
        if (isInsert) {
          if (idx < boundaryIndex && boundaryIndex < idx + span) newSpan = span + count;
        } else {
          const overlap = Math.max(0, Math.min(idx + span, boundaryIndex + count) - Math.max(idx, boundaryIndex));
          if (overlap > 0) newSpan = span - overlap;
        }
        if (newSpan !== span) {
          const base = newCell === cell ? { ...cell } : newCell;
          if (newSpan <= 1) {
            // A 1x1 "merge" isn't a merge.
            const { merge, ...rest } = base;
            newCell = rest;
          } else {
            newCell = { ...base, merge: { ...base.merge, [dimension === 'row' ? 'rows' : 'cols']: newSpan } };
          }
        }
      }

      newCells[newRef] = newCell;
    }

    const newColumnWidths = dimension === 'col'
      ? this._shiftSparseKeys(this.columnWidths, boundaryIndex, count, isInsert, true)
      : this.columnWidths;
    const newRowHeights = dimension === 'row'
      ? this._shiftSparseKeys(this.rowHeights, boundaryIndex, count, isInsert, false)
      : this.rowHeights;

    // Cells patch: null every vacated old ref (nothing occupies it anymore
    // -- _diffKeyedMap's first pass), then a CANONICALIZED full value
    // (explicit null for any of format/merge/actionState the incoming cell
    // doesn't have) for every position whose content actually changed.
    // Canonicalizing matters specifically here, unlike setCellValue()'s
    // deliberately partial {value}-only patches elsewhere: a shift can
    // land a cell on top of a DIFFERENT position that previously held
    // different content, and RFC 7396 merge patch only clears keys
    // explicitly set to null -- an omitted key survives merged into the
    // target on a REMOTE collaborator applying this patch (the local
    // `this.cells = newCells` assignment below is unaffected either way,
    // it's a full replace, not a merge). Only cells whose position or
    // content actually changed are included, to keep the patch small.
    const cellsPatch = {};
    for (const oldRef of Object.keys(this.cells)) {
      if (!(oldRef in newCells)) cellsPatch[oldRef] = null;
    }
    for (const [ref, newCell] of Object.entries(newCells)) {
      if (this.cells[ref] === newCell) continue; // unaffected -- same object at the same key, nothing to send
      cellsPatch[ref] = {
        value: newCell.value,
        format: newCell.format ?? null,
        merge: newCell.merge ?? null,
        actionState: newCell.actionState ?? null,
      };
    }
    const patch = { cells: cellsPatch };
    const widthsDiff = this._diffKeyedMap(this.columnWidths, newColumnWidths);
    const heightsDiff = this._diffKeyedMap(this.rowHeights, newRowHeights);
    if (Object.keys(widthsDiff).length) patch.columnWidths = widthsDiff;
    if (Object.keys(heightsDiff).length) patch.rowHeights = heightsDiff;

    this.cells = newCells;
    this.columnWidths = newColumnWidths;
    this.rowHeights = newRowHeights;
    if (dimension === 'col') {
      this.cols = isInsert ? this.cols + count : Math.max(MIN_COLS, this.cols - count);
      patch.cols = this.cols;
    } else {
      this.rows = isInsert ? this.rows + count : Math.max(MIN_ROWS, this.rows - count);
      patch.rows = this.rows;
    }

    this.anchor = null;
    this.selected = null;
    this._headerAnchorRow = null;
    this._headerAnchorCol = null;
    // Second arg: see applyRemote's doc comment -- ws.js/ws-server thread
    // this through as a sibling of the merge-patch payload (never merged
    // into it, never persisted) purely so every OTHER connected viewer's
    // applyRemote() can remap ITS OWN scroll anchor the same way this
    // (the local, sending) client remaps its own scrollAnchor right below.
    this.onChange(patch, { dimension, boundaryIndex, count, isInsert });
    this._build();
    const newRowIndex = scrollAnchor && dimension === 'row' ? remapIndex(scrollAnchor.rowIndex) : undefined;
    const newColIndex = scrollAnchor && dimension === 'col' ? remapIndex(scrollAnchor.colIndex) : undefined;
    this._restoreScrollAnchor(scrollAnchor, newRowIndex, newColIndex);
  }

  /**
   * Remaps a sparse override map's keys (columnWidths: column letters,
   * rowHeights: 1-indexed row-number strings) the same way
   * _transformStructure remaps cell positions -- an override on column D
   * moves to column E if a column is inserted before D, and is dropped
   * entirely if D itself is deleted.
   */
  _shiftSparseKeys(map, boundaryIndex, count, isInsert, isColKeys) {
    const result = {};
    for (const [key, value] of Object.entries(map)) {
      const idx = isColKeys ? parseRef(key + '1').col : parseInt(key, 10) - 1;
      if (!isInsert && idx >= boundaryIndex && idx < boundaryIndex + count) continue;
      let newIdx = idx;
      if (isInsert) {
        if (idx >= boundaryIndex) newIdx += count;
      } else if (idx >= boundaryIndex + count) {
        newIdx -= count;
      }
      const newKey = isColKeys ? colLetter(newIdx) : String(newIdx + 1);
      result[newKey] = value;
    }
    return result;
  }

  /**
   * Builds a merge-patch fragment from an old->new keyed-object transform:
   * every key present in `oldMap` but absent from `newMap` (vacated) maps
   * to null; every key in `newMap` (occupied, whether it's a survivor at
   * a new position or genuinely new) maps to its value. Order matters --
   * the null pass must run first so a position that's simultaneously
   * vacated-by-one-entry and occupied-by-another ends up with the
   * occupying value, not null.
   */
  _diffKeyedMap(oldMap, newMap) {
    const patch = {};
    for (const key of Object.keys(oldMap)) {
      if (!(key in newMap)) patch[key] = null;
    }
    for (const [key, value] of Object.entries(newMap)) {
      patch[key] = value;
    }
    return patch;
  }
}

// Sentinel returned by Grid.getSelectionFormat() for a format key whose
// value disagrees across the selected cells (as opposed to a key simply
// absent everywhere, which is omitted) -- distinct from `undefined` so
// callers can tell "mixed" apart from "no cell in the selection sets this".
export const FORMAT_MIXED = '__mixed__';

// Deliberately fixed preset list rather than free-text CSS values (per the
// "keep it simple" scope for this feature) -- font-family/size pickers
// offer these labels, format stores the label, rendering maps it to a real
// CSS value here so the mapping only lives in one place. Every stack here
// is fonts that already ship with common OSes (Windows/mac/Linux) -- no
// @font-face, no Google Fonts, nothing fetched over the network (Fernando:
// "include a few other fonts if possible without downloading fonts from
// google" / "I want more added"). No generic sans/serif/monospace entries
// -- Fernando asked for those removed in favor of picking a real font
// (DEFAULT_FONT_FAMILY below covers the "just give me an ordinary
// sans-serif" case); `consolas` and `courier new` both map to real
// monospace stacks so a monospace choice is still available.
export const FONT_FAMILIES = {
  arial: 'Arial, Helvetica, sans-serif',
  'arial black': '"Arial Black", Gadget, sans-serif',
  calibri: 'Calibri, Candara, sans-serif',
  cambria: 'Cambria, Georgia, serif',
  'century gothic': '"Century Gothic", Arial, sans-serif',
  'comic sans ms': '"Comic Sans MS", "Comic Sans", cursive',
  consolas: 'Consolas, "Courier New", monospace',
  'courier new': '"Courier New", Courier, monospace',
  'franklin gothic medium': '"Franklin Gothic Medium", Arial, sans-serif',
  garamond: 'Garamond, "Times New Roman", serif',
  georgia: 'Georgia, serif',
  impact: 'Impact, "Arial Narrow", sans-serif',
  'lucida sans unicode': '"Lucida Sans Unicode", "Lucida Grande", sans-serif',
  palatino: '"Palatino Linotype", "Book Antiqua", Palatino, serif',
  'segoe ui': '"Segoe UI", Tahoma, sans-serif',
  tahoma: 'Tahoma, Geneva, sans-serif',
  'times new roman': '"Times New Roman", Times, serif',
  'trebuchet ms': '"Trebuchet MS", sans-serif',
  verdana: 'Verdana, Geneva, sans-serif',
};

// format.fontSize is a plain point-size number now (matches Excel/Word's
// own font-size convention), not a preset key like the old small/normal/
// large/xlarge -- see CELL_SCHEMA.md. This is the fixed dropdown list of
// common sizes (Fernando: "use the common font size numbers 8 - 72"), not
// free-text -- cell rendering still just does `fmt.fontSize + 'pt'`
// directly for any of these.
export const FONT_SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 60, 72];

// What a cell actually renders as when format.fontFamily/fontSize is unset
// (see _renderCell above: '' falls through to body's own CSS) -- 'arial'
// is an ordinary, universally-available sans-serif close to body's own
// system-ui stack, and 11 is body's --font-size-base (0.95rem, i.e.
// ~15.2px at a 16px root) converted to the nearest whole point (1px =
// 0.75pt) and rounded to the closest FONT_SIZES entry. Used by the toolbar
// to preselect the selection's real effective value in its normal sorted
// list position (see updateEffectiveFontOptions in app.js).
export const DEFAULT_FONT_FAMILY = 'arial';
export const DEFAULT_FONT_SIZE = 11;
