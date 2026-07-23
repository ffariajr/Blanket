// Grid rendering + editing. Per-tab, resizable dimensions (this.cols/
// this.rows -- see CELL_SCHEMA.md "cols/rows"), not a fixed global canvas
// -- a new tab defaults to 6 cols (A-F) x 20 rows (set server-side, see
// TabController::DEFAULT_COLS/DEFAULT_ROWS) and grows/shrinks via
// insertRowsAt/deleteRowsAt/insertColumnsAt/deleteColumnsAt below.
// Sparse cell data: {"A1": {value, format, merge}}.
import {
  isFormula, evaluateFormula, colLetter, parseRef, parseActionGroup,
  shiftFormulaReferences, shiftReferencesForStructuralChange, extractReferences,
} from './formulas.js?v=__DEPLOY_VERSION__';
import { getUserInfoField, setUserInfoField } from './api.js?v=__DEPLOY_VERSION__';

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
 * field, returns {key, value} (value = its current cookie/account value,
 * possibly '') so _runActionGroup can collect every field referenced
 * anywhere in the group -- across every action, not just the ones missing
 * a value -- and decide as a whole whether to show app.js's consolidated
 * onNeedUserInfo dialog (only if at least one is missing) with all of them
 * listed (so an already-known field is shown pre-filled/editable, not
 * hidden). A future action type with its own resolvable field plugs in
 * here the same way, without _runActionGroup itself knowing anything
 * about "infoType" or USERINFO specifically.
 */
const ACTION_NEEDS = {
  USERINFO(action) {
    return { key: action.infoType, value: getUserInfoField(action.infoType) };
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
   * @param {(patch: object) => void} opts.onChange called with a
   *   full-document-shaped merge patch (e.g. {cells: {...}} or
   *   {columnWidths: {...}}) on any local edit -- this is the wire shape
   *   ws-server/merge_patch.py expects, and the ONLY place that shape is
   *   assembled, so callers (app.js) never need to know about it.
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
    this._build();
  }

  // --- Remote state / patches --------------------------------------

  /** Full document replace (e.g. on initial WS "state" message or reload). */
  setDocument(doc) {
    doc = doc || {};
    this.cells = doc.cells || {};
    this.columnWidths = doc.columnWidths || {};
    this.rowHeights = doc.rowHeights || {};
    this.cols = doc.cols || LEGACY_COLS;
    this.rows = doc.rows || LEGACY_ROWS;
    this._build();
  }

  /**
   * Apply a remote merge patch (from another collaborator) -- the same
   * full-document shape onChange emits, not a bare cell patch. A cell
   * patch whose value touches `merge` forces a structural rebuild (the
   * table's actual TD layout depends on which cells are merge-covered);
   * anything else updates in place.
   */
  applyRemote(patch) {
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
        if (!structural) this._renderCell(ref);
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
    } else if (changedRefs) {
      // Structural changes already re-render every cell via _build()'s
      // _renderAll() -- only the non-structural path needs an explicit
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
    this.container.className = 'grid-scroll' + (this.readOnly ? ' grid-readonly' : '');
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
    headRow.appendChild(document.createElement('th'));
    for (let c = 0; c < this.cols; c++) {
      const letter = colLetter(c);
      const th = document.createElement('th');
      th.textContent = letter;
      th.dataset.colIndex = String(c);
      // mousedown (not click) so drag-across-headers can extend a
      // multi-column selection the same way cell drag-select works --
      // see _onColHeaderMouseDown/_onMouseMoveDrag.
      th.addEventListener('mousedown', (e) => this._onColHeaderMouseDown(e, c));
      th.appendChild(this._colResizeHandle(letter, this._colElements[c]));
      headRow.appendChild(th);
      this._colHeaderElements.push(th);
    }
    thead.appendChild(headRow);
    table.appendChild(thead);

    // ref -> td, populated while building so _cellEl() below is an O(1)
    // Map lookup instead of a querySelector scan. With a fixed 30x100 =
    // 3000-cell grid and _renderAll() (full re-render, on every structural
    // rebuild -- merge/unmerge/remote-merge-patch, not just initial load)
    // calling _cellEl() once per cell, querySelector-per-cell is O(cells²)
    // work every rebuild -- caught this empirically: harmless-looking in a
    // real browser at this cell count, but pathologically slow under
    // jsdom's unindexed selector engine during testing (60s+, not just
    // "a bit slow"), which is a real cost even if browsers hide it better.
    this._cellElements = new Map();

    this._rowElements = [];
    this._rowHeaderElements = [];
    const tbody = document.createElement('tbody');
    for (let r = 0; r < this.rows; r++) {
      const rowNum = r + 1;
      const rowHeight = this.rowHeights[rowNum] || DEFAULT_ROW_HEIGHT;
      const tr = document.createElement('tr');
      tr.style.height = rowHeight + 'px';
      this._rowElements.push(tr);
      const rowHead = document.createElement('th');
      rowHead.textContent = String(rowNum);
      rowHead.dataset.rowIndex = String(r);
      rowHead.addEventListener('mousedown', (e) => this._onRowHeaderMouseDown(e, r));
      this._rowHeaderElements.push(rowHead);
      rowHead.appendChild(this._rowResizeHandle(rowNum, tr));
      // A <tr height> is only a floor in table layout -- content taller
      // than it (e.g. a large font-size, see .toolbar's font-size
      // control) grows the row instead of clipping, which is what
      // Fernando's "changing font size should not resize cell to fit"
      // is about. An explicit height + overflow:hidden directly on each
      // cell (not just the row) is what actually clips oversized
      // content -- percentage heights inside table cells resolve
      // inconsistently enough across browsers that hardcoding the real
      // pixel value here, kept in sync with the row height everywhere it
      // changes (_applyRowHeights, the live-drag path in _onResizeMove),
      // is the reliable option. Skipped for a rowSpan>1 origin cell
      // below -- its natural height is the sum of the rows it spans, not
      // this one row's height alone.
      rowHead.style.height = rowHeight + 'px';
      rowHead.style.overflow = 'hidden';
      tr.appendChild(rowHead);
      for (let c = 0; c < this.cols; c++) {
        const ref = colLetter(c) + rowNum;
        if (this._coverage.has(ref)) continue; // reserved by an earlier cell's colspan/rowspan
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
        tr.appendChild(td);
        this._cellElements.set(ref, td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
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

    this._renderAll();

    // Restore selection across a structural rebuild (merge/unmerge, remote
    // merge patch, resize) so the user doesn't lose their place.
    if (prevSelected && this._cellEl(prevSelected)) {
      this.anchor = prevAnchor && this._cellEl(prevAnchor) ? prevAnchor : prevSelected;
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

  _renderAll() {
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        const ref = colLetter(c) + (r + 1);
        if (!this._isCovered(ref)) this._renderCell(ref);
      }
    }
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
      inner.textContent = isFormula(raw) ? String(evaluateFormula(raw, (r) => this._resolveRef(r))) : raw;
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
   */
  _renderActionGroupCell(ref, el, { buttonText, hideOnClick, actions }, cell) {
    const clicked = !!(cell && cell.actionState && cell.actionState.clicked);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'actiongroup-btn';
    btn.textContent = buttonText;
    btn.disabled = this.readOnly || (hideOnClick && clicked);
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
   * blank in the dialog (or the whole dialog dismissed) is skipped without
   * aborting the rest.
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
      if (need && !fields.has(need.key)) fields.set(need.key, need.value);
    }
    const resolved = Object.fromEntries(fields);
    if ([...fields.values()].some((v) => !v)) {
      const entered = await this.onNeedUserInfo([...fields.entries()].map(([infoType, value]) => ({ infoType, value })));
      if (entered) {
        for (const [key, value] of Object.entries(entered)) {
          const trimmed = (value || '').trim();
          if (trimmed) { setUserInfoField(key, trimmed); resolved[key] = trimmed; }
        }
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
    for (const cell of Object.values(this.cells)) {
      if (!cell || !isFormula(cell.value)) continue;
      const actionGroup = parseActionGroup(cell.value);
      if (!actionGroup) continue;
      for (const action of actionGroup.actions) {
        if (action.type === 'USERINFO' && action.saveOnEdit) {
          watches.set(action.cell, action.infoType);
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
   * structural patches, insert/delete row/col) re-renders every cell via
   * _renderAll() regardless, so dependents are already covered there.
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
    if (!td) return;
    // Stop native text-selection/drag-highlight; our own selection
    // handling below is what should happen instead.
    e.preventDefault();
    this._dragging = true;
    this._select(td.dataset.ref, e.shiftKey);
  }

  _onMouseMoveDrag(e) {
    // Dragging across row/col headers (started by _onRowHeaderMouseDown/
    // _onColHeaderMouseDown below) extends a whole-row/whole-column
    // selection instead of the plain cell-range drag below -- same
    // mousemove listener, different branch, since both need "which header
    // is the pointer over right now" from the same event.
    if (this._headerDragging === 'row') {
      const th = e.target.closest('tbody th');
      if (th && th.dataset.rowIndex !== undefined) this.selectWholeRow(Number(th.dataset.rowIndex), true);
      return;
    }
    if (this._headerDragging === 'col') {
      const th = e.target.closest('thead th');
      if (th && th.dataset.colIndex !== undefined) this.selectWholeColumn(Number(th.dataset.colIndex), true);
      return;
    }
    if (!this._dragging) return;
    const td = e.target.closest('td');
    if (!td || td.dataset.ref === this.selected) return;
    this.selected = td.dataset.ref;
    this._highlightRange(this.anchor, this.selected);
  }

  _onMouseUp() {
    if (this._headerDragging) {
      this._headerDragging = null;
      this.container.dispatchEvent(new CustomEvent('cellselect', { detail: { ref: this.selected } }));
      return;
    }
    if (!this._dragging) return;
    this._dragging = false;
    this.container.dispatchEvent(new CustomEvent('cellselect', { detail: { ref: this.selected } }));
  }

  _onCellDblClick(e) {
    const td = e.target.closest('td');
    if (!td || this.readOnly) return;
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
    const cellTd = e.target.closest('td');
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
    this._highlightRange(this.anchor, this.selected);
    if (this.onSelectionChange) this.onSelectionChange(this.selected);
  }

  _onRowHeaderMouseDown(e, rowIndex) {
    if (e.button !== 0) return; // right-click is handled by _onContextMenu, don't also start a drag-select
    e.preventDefault();
    this._headerDragging = 'row';
    this.selectWholeRow(rowIndex, e.shiftKey);
  }

  _onColHeaderMouseDown(e, colIndex) {
    if (e.button !== 0) return;
    e.preventDefault();
    this._headerDragging = 'col';
    this.selectWholeColumn(colIndex, e.shiftKey);
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
    } else {
      this.cells[ref] = { ...prev, value };
      this.onChange({ cells: { [ref]: { value } } });
      const watchedInfoType = this._buildActionGroupWatches().get(ref);
      if (watchedInfoType) setUserInfoField(watchedInfoType, value);
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
  _applyTsvAtSelection(text, origin) {
    if (!text) return;
    const startCell = parseRef(this.selected);
    const deltaCols = origin ? startCell.col - origin.col : 0;
    const deltaRows = origin ? startCell.row - origin.row : 0;
    const lines = text.replace(/\r/g, '').split('\n').filter((l, i, a) => !(i === a.length - 1 && l === ''));
    lines.forEach((line, r) => {
      line.split('\t').forEach((value, c) => {
        const ref = colLetter(startCell.col + c) + (startCell.row + r + 1);
        if (value === '' || this._isCovered(ref)) return;
        const toWrite = origin && isFormula(value) ? shiftFormulaReferences(value, deltaCols, deltaRows) : value;
        this.setCellValue(ref, toWrite);
      });
    });
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
          // Only trust the origin (for ref-shifting) if what came back is
          // exactly our own last copy -- different text means it came
          // from outside the app (or a different copy we didn't track),
          // so there's no known origin to shift from.
          const origin = text === this._internalClipboard ? this._internalClipboardOrigin : undefined;
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
   * Deliberately doesn't route through setCellValue()/its saveOnEdit watch
   * hook: clearing a cell isn't "the user typed a new value" for that
   * field, and syncing an empty string would erase their remembered email/
   * name just because they cleared one cell that happened to display it --
   * worse than not syncing at all (see CELL_SCHEMA.md, ACTIONGROUP/USERINFO
   * cells).
   */
  _clearSelection() {
    if (this.readOnly || !this.anchor || !this.selected) return;
    const cleared = [];
    for (const ref of this._visibleRangeRefs(this.anchor, this.selected)) {
      if (this.cells[ref]) {
        delete this.cells[ref];
        this.onChange({ cells: { [ref]: null } });
        this._renderCell(ref);
        cleared.push(ref);
      }
    }
    if (cleared.length) this._recalcDependents(cleared);
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
    return { ok: true };
  }

  unmergeSelection() {
    if (this.readOnly || !this.selected) return { ok: false, error: 'Nothing selected' };
    const origin = this._isCovered(this.selected) ? this._originOf(this.selected) : this.selected;
    if (!origin || !this.cells[origin] || !this.cells[origin].merge) {
      return { ok: false, error: 'Selection is not a merged cell' };
    }
    const { merge, ...rest } = this.cells[origin];
    this.cells[origin] = rest;
    this.onChange({ cells: { [origin]: { merge: null } } });
    this._build();
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
        const shifted = shiftReferencesForStructuralChange(cell.value, dimension, boundaryIndex, count, isInsert);
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
    this.onChange(patch);
    this._build();
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
