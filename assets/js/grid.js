// Grid rendering + editing. Fixed-size viewport grid (cols A..AD, 100
// rows) -- generous for a small church spreadsheet app without needing
// virtualized/infinite scroll. Sparse cell data: {"A1": {value, format, merge}}.
import { isFormula, evaluateFormula, colLetter, parseRef, parseUserInfo, shiftFormulaReferences } from './formulas.js';
import { getUserInfoField, setUserInfoField } from './api.js';

const COLS = 30; // A..AD
const ROWS = 100;
const DEFAULT_COL_WIDTH = 96;
const DEFAULT_ROW_HEIGHT = 28;
const MIN_COL_WIDTH = 32;
const MIN_ROW_HEIGHT = 18;

export { colLetter };

export class Grid {
  /**
   * @param {HTMLElement} container
   * @param {object} opts.document {cells, columnWidths, rowHeights} -- the
   *   full tab document shape (see CELL_SCHEMA.md). columnWidths/
   *   rowHeights are sparse (col letter / row number -> px override).
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
    this.onChange = onChange || (() => {});
    this.readOnly = !!readOnly;
    this.selected = null; // ref string
    this.anchor = null; // for range selection
    this.editingInput = null;
    this._dragging = false;
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
    this._build();
  }

  // --- Remote state / patches --------------------------------------

  /** Full document replace (e.g. on initial WS "state" message or reload). */
  setDocument(doc) {
    doc = doc || {};
    this.cells = doc.cells || {};
    this.columnWidths = doc.columnWidths || {};
    this.rowHeights = doc.rowHeights || {};
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
    const colgroup = document.createElement('colgroup');
    colgroup.appendChild(document.createElement('col')); // row-header column
    for (let c = 0; c < COLS; c++) {
      const col = document.createElement('col');
      col.style.width = (this.columnWidths[colLetter(c)] || DEFAULT_COL_WIDTH) + 'px';
      colgroup.appendChild(col);
      this._colElements.push(col);
    }
    table.appendChild(colgroup);

    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    headRow.appendChild(document.createElement('th'));
    for (let c = 0; c < COLS; c++) {
      const letter = colLetter(c);
      const th = document.createElement('th');
      th.textContent = letter;
      th.appendChild(this._colResizeHandle(letter, this._colElements[c]));
      headRow.appendChild(th);
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
    const tbody = document.createElement('tbody');
    for (let r = 0; r < ROWS; r++) {
      const rowNum = r + 1;
      const tr = document.createElement('tr');
      tr.style.height = (this.rowHeights[rowNum] || DEFAULT_ROW_HEIGHT) + 'px';
      this._rowElements.push(tr);
      const rowHead = document.createElement('th');
      rowHead.textContent = String(rowNum);
      rowHead.appendChild(this._rowResizeHandle(rowNum, tr));
      tr.appendChild(rowHead);
      for (let c = 0; c < COLS; c++) {
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
      this._resizing = {
        kind: 'col', key: letter, startPx: e.clientX,
        startSize: this.columnWidths[letter] || DEFAULT_COL_WIDTH,
        el: colEl,
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
    } else {
      const size = Math.max(MIN_ROW_HEIGHT, startSize + (e.clientY - startPx));
      this._resizing.liveSize = size;
      if (el) el.style.height = size + 'px';
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
    for (let c = 0; c < COLS; c++) {
      const width = this.columnWidths[colLetter(c)] || DEFAULT_COL_WIDTH;
      if (this._colElements[c]) this._colElements[c].style.width = width + 'px';
    }
  }

  /** Row-height counterpart of _applyColumnWidths -- same reasoning, see its doc comment. */
  _applyRowHeights() {
    if (!this._rowElements) return;
    for (let r = 0; r < ROWS; r++) {
      const rowNum = r + 1;
      const height = this.rowHeights[rowNum] || DEFAULT_ROW_HEIGHT;
      if (this._rowElements[r]) this._rowElements[r].style.height = height + 'px';
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
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const ref = colLetter(c) + (r + 1);
        if (!this._isCovered(ref)) this._renderCell(ref);
      }
    }
  }

  _renderCell(ref) {
    const el = this._cellEl(ref);
    if (!el) return; // covered by a merge, or not yet built -- nothing to render
    el.innerHTML = ''; // clear any previous button/input child left from a prior render
    const cell = this.cells[ref];
    const raw = cell && cell.value !== undefined ? cell.value : '';

    // USERINFO is checked before the normal formula evaluator -- see
    // parseUserInfo() in formulas.js for why it can't go through
    // evaluateFormula() like SUM etc.
    const userInfo = parseUserInfo(raw);
    if (userInfo) {
      this._renderUserInfoCell(ref, el, userInfo);
    } else {
      el.textContent = isFormula(raw) ? String(evaluateFormula(raw, (r) => this._resolveRef(r))) : raw;
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
    if (!this._dragging) return;
    const td = e.target.closest('td');
    if (!td || td.dataset.ref === this.selected) return;
    this.selected = td.dataset.ref;
    this._highlightRange(this.anchor, this.selected);
  }

  _onMouseUp() {
    if (!this._dragging) return;
    this._dragging = false;
    this.container.dispatchEvent(new CustomEvent('cellselect', { detail: { ref: this.selected } }));
  }

  _onCellDblClick(e) {
    const td = e.target.closest('td');
    if (!td || this.readOnly) return;
    this._beginEdit(td.dataset.ref);
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
      // Deliberately doesn't route through setCellValue()/its userinfo-
      // cookie-sync hook: clearing a cell isn't "the user typed a new
      // value" for that field, and syncing an empty string would erase
      // their remembered email/name just because they cleared one cell
      // that happened to display it -- worse than not syncing at all.
      for (const ref of this._visibleRangeRefs(this.anchor, this.selected)) {
        if (this.cells[ref]) {
          delete this.cells[ref];
          this.onChange({ cells: { [ref]: null } });
          this._renderCell(ref);
        }
      }
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
    let col = Math.min(COLS - 1, Math.max(0, p.col + dc));
    let row = Math.min(ROWS - 1, Math.max(0, p.row + dr));
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
