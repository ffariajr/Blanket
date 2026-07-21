// Grid rendering + editing. Per-tab, resizable dimensions (this.cols/
// this.rows -- see CELL_SCHEMA.md "cols/rows"), not a fixed global canvas
// -- a new tab defaults to 6 cols (A-F) x 20 rows (set server-side, see
// TabController::DEFAULT_COLS/DEFAULT_ROWS) and grows/shrinks via
// insertRowsAt/deleteRowsAt/insertColumnsAt/deleteColumnsAt below.
// Sparse cell data: {"A1": {value, format, merge}}.
import {
  isFormula, evaluateFormula, colLetter, parseRef, parseUserInfo,
  shiftFormulaReferences, shiftReferencesForStructuralChange,
} from './formulas.js';
import { getUserInfoField, setUserInfoField } from './api.js';

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
   */
  constructor(container, { document: doc, onChange, readOnly }) {
    this.container = container;
    doc = doc || {};
    this.cells = doc.cells || {};
    this.columnWidths = doc.columnWidths || {};
    this.rowHeights = doc.rowHeights || {};
    this.cols = doc.cols || LEGACY_COLS;
    this.rows = doc.rows || LEGACY_ROWS;
    this.onChange = onChange || (() => {});
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
    if (patch.cells) {
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
    if (structural) this._build();
  }

  // --- Build / render -------------------------------------------------

  _build() {
    const prevSelected = this.selected;
    const prevAnchor = this.anchor;
    this.container.innerHTML = '';
    this.container.className = 'grid-scroll';
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

    // USERINFO is checked before the normal formula evaluator -- see
    // parseUserInfo() in formulas.js for why it can't go through
    // evaluateFormula() like SUM etc.
    const userInfo = parseUserInfo(raw);
    if (userInfo) {
      this._renderUserInfoCell(ref, inner, userInfo);
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
   * Renders a cell whose raw value parsed as a USERINFO(...) call (see
   * parseUserInfo() in formulas.js and CELL_SCHEMA.md for the full design).
   *
   * buttonLabel non-empty -> button mode: a clickable button, resolved
   * on click via _resolveUserInfoButton -- a ONE-SHOT conversion to a
   * plain literal value (this.cells[ref] no longer holds a USERINFO
   * formula afterward, ever again for this cell).
   *
   * buttonLabel empty -> plain-cell mode: NOT one-shot in the same way,
   * because autoSaveToCookie needs to keep syncing on every future edit,
   * not just the first. So instead of collapsing straight to a bare
   * literal, this converts (still just once, the first time this cell is
   * ever rendered) to a durable {value, userinfo: {field, autoSaveToCookie}}
   * shape -- an ordinary editable cell from here on, except setCellValue()
   * below checks for that lingering `userinfo` marker on every future edit
   * to keep the cookie in sync. Deliberately mutates this.cells[ref]
   * directly (same as evaluateFormula's callers never do, but USERINFO
   * always needs to, per the one-shot-conversion design) -- that mutation
   * IS what prevents this from re-firing on every later render/rebuild:
   * once cell.value is a plain string, parseUserInfo() on it returns null
   * immediately (isFormula() fails first), so this method never runs
   * again for that ref.
   *
   * Firing this.onChange() from inside a render method is unusual (nothing
   * else here has render-time side effects) but necessary: without
   * persisting the resolution, reloading the page would just show the raw
   * =USERINFO(...) formula again, since nothing was ever saved.
   */
  _renderUserInfoCell(ref, el, { buttonLabel, field, autoSaveToCookie }) {
    if (buttonLabel !== '') {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'userinfo-btn';
      btn.textContent = buttonLabel;
      btn.disabled = this.readOnly;
      btn.addEventListener('mousedown', (e) => e.stopPropagation()); // don't start a drag-select under the button
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._resolveUserInfoButton(ref, field);
      });
      el.appendChild(btn);
      return;
    }

    if (this.readOnly) {
      // Can't write the resolution back, so just show whatever's
      // resolvable for display without persisting anything.
      el.textContent = autoSaveToCookie ? getUserInfoField(field) : '';
      return;
    }

    const cookieValue = autoSaveToCookie ? getUserInfoField(field) : '';
    const nextCell = autoSaveToCookie
      ? { value: cookieValue, userinfo: { field, autoSaveToCookie: true } }
      : { value: '' };
    this.cells[ref] = nextCell;
    el.textContent = nextCell.value;
    this.onChange({ cells: { [ref]: nextCell } });
  }

  /**
   * Button-mode click: resolve `field` for the current viewer and commit
   * it as the cell's new literal value via the normal setCellValue() path
   * (same commit path as typing/formula-bar/paste -- not a parallel one).
   * If unresolvable (e.g. an anonymous viewer, field="email", no cookie
   * yet), prompts inline -- consistent with the existing first-visit name
   * prompt pattern elsewhere in this app -- and stores what they enter for
   * reuse by other USERINFO cells.
   */
  _resolveUserInfoButton(ref, field) {
    if (this.readOnly) return;
    let value = getUserInfoField(field);
    if (!value) {
      const label = field === 'email' ? 'Your email address' : 'Your name';
      const entered = window.prompt(label);
      if (!entered || !entered.trim()) return; // cancelled/blank -- leave the button as it was
      value = entered.trim();
      setUserInfoField(field, value);
    }
    this.setCellValue(ref, value);
  }

  /** Resolves a ref to its evaluated value (number or string) for use inside another cell's formula. */
  _resolveRef(ref) {
    const cell = this.cells[ref];
    if (!cell || cell.value === undefined) return '';
    return isFormula(cell.value) ? evaluateFormula(cell.value, (r) => this._resolveRef(r)) : cell.value;
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
   * editing, the formula bar, paste, and USERINFO button-click resolution,
   * so anything that changes a cell's value goes through one place.
   *
   * If the cell carries `userinfo: {field, autoSaveToCookie: true}` (set
   * once by _renderUserInfoCell's plain-mode conversion -- see there for
   * why that state has to persist rather than being one-shot), every
   * future edit to it also re-syncs the field's cookie, so e.g. correcting
   * a mistyped email keeps the remembered value current too.
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
      if (prev.userinfo && prev.userinfo.autoSaveToCookie) {
        setUserInfoField(prev.userinfo.field, value);
      }
    }
    this._renderCell(ref);
  }

  _onKeyDown(e) {
    if (this.editingInput || !this.selected) return;
    if (this._keyboardShouldDeferToOtherControl()) return;

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
      // directly instead of relying on that event.
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
  // directly) so paste picks up the userinfo-cookie-sync hook there for
  // free instead of silently bypassing it -- pasting a new value into a
  // tracked cell is still "editing that cell going forward" per
  // CELL_SCHEMA.md's USERINFO semantics, same as typing or the formula bar.
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
   * Deliberately doesn't route through setCellValue()/its userinfo-cookie-
   * sync hook: clearing a cell isn't "the user typed a new value" for that
   * field, and syncing an empty string would erase their remembered email/
   * name just because they cleared one cell that happened to display it --
   * worse than not syncing at all (see CELL_SCHEMA.md, USERINFO cells).
   */
  _clearSelection() {
    if (this.readOnly || !this.anchor || !this.selected) return;
    for (const ref of this._visibleRangeRefs(this.anchor, this.selected)) {
      if (this.cells[ref]) {
        delete this.cells[ref];
        this.onChange({ cells: { [ref]: null } });
        this._renderCell(ref);
      }
    }
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
    if (!this.selected || this.editingInput) return;
    if (this._keyboardShouldDeferToOtherControl()) return;
    e.clipboardData.setData('text/plain', this._selectionToTsv());
    e.preventDefault();
  }

  _onPaste(e) {
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

  /** Current selection's format, read from the anchor cell -- lets the toolbar show/toggle current state instead of blindly forcing bold/italic/etc. on. */
  getSelectionFormat() {
    if (!this.anchor) return {};
    return (this.cells[this.anchor] && this.cells[this.anchor].format) || {};
  }

  toggleFormatOnSelection(key) {
    const current = !!this.getSelectionFormat()[key];
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
    // (explicit null for any of format/merge/userinfo the incoming cell
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
        userinfo: newCell.userinfo ?? null,
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

// Deliberately small, fixed preset lists rather than free-text CSS values
// (per the "keep it simple" scope for this feature) -- font-family/size
// pickers offer these labels, format stores the label, rendering maps it
// to a real CSS value here so the mapping only lives in one place.
export const FONT_FAMILIES = {
  sans: 'system-ui, sans-serif',
  serif: 'Georgia, "Times New Roman", serif',
  monospace: '"SFMono-Regular", Consolas, monospace',
};

// format.fontSize is a plain point-size number now (matches Excel/Word's
// own font-size convention), not a preset key like the old small/normal/
// large/xlarge -- see CELL_SCHEMA.md. This is the fixed dropdown list of
// common sizes (Fernando: "use the common font size numbers 8 - 72"), not
// free-text -- cell rendering still just does `fmt.fontSize + 'pt'`
// directly for any of these.
export const FONT_SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 60, 72];
