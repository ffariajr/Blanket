// Grid rendering + editing. Fixed-size viewport grid (cols A..AD, 100
// rows) -- generous for a small church spreadsheet app without needing
// virtualized/infinite scroll. Sparse cell data: {"A1": {value, format}}.
import { isFormula, evaluateFormula } from './formulas.js';

const COLS = 30; // A..AD
const ROWS = 100;

export function colLetter(index) {
  let letter = '';
  index++;
  while (index > 0) {
    const rem = (index - 1) % 26;
    letter = String.fromCharCode(65 + rem) + letter;
    index = Math.floor((index - 1) / 26);
  }
  return letter;
}

export class Grid {
  /**
   * @param {HTMLElement} container
   * @param {object} opts.cells initial cells dict
   * @param {(patch: object) => void} opts.onChange called with a merge
   *   patch (just the changed cell) whenever a cell is edited
   * @param {boolean} opts.readOnly
   */
  constructor(container, { cells, onChange, readOnly }) {
    this.container = container;
    this.cells = cells || {};
    this.onChange = onChange || (() => {});
    this.readOnly = !!readOnly;
    this.selected = null; // {row, col}
    this.anchor = null; // for range selection
    this.editingInput = null;
    this._dragging = false;
    // In-app clipboard fallback for when the OS Clipboard API is
    // unavailable (non-secure context, permission denied) -- copy/paste
    // still work within the app itself either way.
    this._internalClipboard = '';
    this._build();
  }

  // Apply a remote merge patch (from another collaborator) without
  // re-triggering onChange.
  applyRemote(patch) {
    for (const [ref, value] of Object.entries(patch)) {
      if (value === null) delete this.cells[ref];
      else this.cells[ref] = { ...(this.cells[ref] || {}), ...value };
      this._renderCell(ref);
    }
  }

  setCells(cells) {
    this.cells = cells || {};
    this._renderAll();
  }

  _build() {
    this.container.innerHTML = '';
    this.container.className = 'grid-scroll';
    const table = document.createElement('table');
    table.className = 'grid';
    this.table = table;

    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    headRow.appendChild(document.createElement('th'));
    for (let c = 0; c < COLS; c++) {
      const th = document.createElement('th');
      th.textContent = colLetter(c);
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    for (let r = 0; r < ROWS; r++) {
      const tr = document.createElement('tr');
      const rowHead = document.createElement('th');
      rowHead.textContent = String(r + 1);
      tr.appendChild(rowHead);
      for (let c = 0; c < COLS; c++) {
        const ref = colLetter(c) + (r + 1);
        const td = document.createElement('td');
        td.dataset.ref = ref;
        td.tabIndex = -1;
        tr.appendChild(td);
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
    table.addEventListener('mousedown', (e) => this._onMouseDown(e));
    table.addEventListener('mousemove', (e) => this._onMouseMoveDrag(e));
    document.addEventListener('mouseup', () => this._onMouseUp());
    table.addEventListener('dblclick', (e) => this._onCellDblClick(e));
    document.addEventListener('keydown', (e) => this._onKeyDown(e));
    document.addEventListener('paste', (e) => this._onPaste(e));
    document.addEventListener('copy', (e) => this._onCopy(e));

    this._renderAll();
  }

  _cellEl(ref) {
    return this.table.querySelector(`td[data-ref="${ref}"]`);
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
      for (let c = 0; c < COLS; c++) this._renderCell(colLetter(c) + (r + 1));
    }
  }

  _renderCell(ref) {
    const el = this._cellEl(ref);
    if (!el) return;
    const cell = this.cells[ref];
    const raw = cell && cell.value !== undefined ? cell.value : '';
    el.textContent = isFormula(raw) ? String(evaluateFormula(raw, (r) => this._numericOf(r))) : raw;

    const fmt = (cell && cell.format) || {};
    el.classList.toggle('bold', !!fmt.bold);
    el.classList.toggle('italic', !!fmt.italic);
    el.style.color = fmt.color || '';
    el.style.background = fmt.bg || '';
  }

  _numericOf(ref) {
    const cell = this.cells[ref];
    if (!cell || cell.value === undefined) return 0;
    const v = isFormula(cell.value) ? evaluateFormula(cell.value, (r) => this._numericOf(r)) : cell.value;
    const n = parseFloat(v);
    return isNaN(n) ? 0 : n;
  }

  _onMouseDown(e) {
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
  }

  _highlightRange(a, b) {
    this.table.querySelectorAll('td.selected').forEach((el) => el.classList.remove('selected'));
    for (const ref of this._rangeRefs(a, b)) {
      const el = this._cellEl(ref);
      if (el) el.classList.add('selected');
    }
  }

  _rangeRefs(a, b) {
    const pa = this._parseRef(a);
    const pb = this._parseRef(b);
    const refs = [];
    for (let r = Math.min(pa.row, pb.row); r <= Math.max(pa.row, pb.row); r++) {
      for (let c = Math.min(pa.col, pb.col); c <= Math.max(pa.col, pb.col); c++) {
        refs.push(colLetter(c) + (r + 1));
      }
    }
    return refs;
  }

  _parseRef(ref) {
    const m = ref.match(/^([A-Z]+)(\d+)$/);
    let col = 0;
    for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
    return { col: col - 1, row: parseInt(m[2], 10) - 1 };
  }

  _beginEdit(ref) {
    if (this.readOnly) return;
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

    const prev = this.cells[ref] || {};
    if (value === '') {
      delete this.cells[ref];
      this.onChange({ [ref]: null });
    } else {
      this.cells[ref] = { ...prev, value };
      this.onChange({ [ref]: { value } });
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
      for (const ref of this._rangeRefs(this.anchor, this.selected)) {
        if (this.cells[ref]) {
          delete this.cells[ref];
          this.onChange({ [ref]: null });
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

  _moveSelection(dc, dr) {
    const p = this._parseRef(this.selected);
    const col = Math.min(COLS - 1, Math.max(0, p.col + dc));
    const row = Math.min(ROWS - 1, Math.max(0, p.row + dr));
    this._select(colLetter(col) + (row + 1), false);
  }

  // Tab-separated between columns, newline-separated between rows -- the
  // de facto interchange format spreadsheet apps use for clipboard data,
  // so this round-trips with pasting into/from a real spreadsheet app.
  _selectionToTsv() {
    const refs = this._rangeRefs(this.anchor, this.selected);
    const rows = {};
    for (const ref of refs) {
      const { row } = this._parseRef(ref);
      (rows[row] = rows[row] || []).push((this.cells[ref] && this.cells[ref].value) || '');
    }
    return Object.keys(rows).sort((a, b) => a - b).map((r) => rows[r].join('\t')).join('\n');
  }

  _applyTsvAtSelection(text) {
    if (!text) return;
    const startCell = this._parseRef(this.selected);
    const lines = text.replace(/\r/g, '').split('\n').filter((l, i, a) => !(i === a.length - 1 && l === ''));
    lines.forEach((line, r) => {
      line.split('\t').forEach((value, c) => {
        const ref = colLetter(startCell.col + c) + (startCell.row + r + 1);
        if (value === '') return;
        this.cells[ref] = { ...(this.cells[ref] || {}), value };
        this.onChange({ [ref]: { value } });
        this._renderCell(ref);
      });
    });
  }

  // Ctrl/Cmd+C path (see _onKeyDown): writes to the real OS clipboard via
  // the async Clipboard API when available (requires a secure context --
  // true in production, not necessarily true under local http:// dev),
  // and always to the in-app fallback so copy/paste still works within
  // the app regardless.
  _copySelectionToClipboard() {
    if (!this.selected || this.editingInput) return;
    const tsv = this._selectionToTsv();
    this._internalClipboard = tsv;
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
        .then((text) => this._applyTsvAtSelection(text || this._internalClipboard))
        .catch(() => this._applyTsvAtSelection(this._internalClipboard));
    } else {
      this._applyTsvAtSelection(this._internalClipboard);
    }
  }

  // Native copy/paste events: only fire given an actual browser
  // text/DOM selection or focus in an editable element, which plain cell
  // clicks never create -- so in practice these rarely trigger. Kept as a
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
    for (const ref of this._rangeRefs(this.anchor, this.selected)) {
      const prev = this.cells[ref] || {};
      const nextFormat = { ...(prev.format || {}), ...format };
      this.cells[ref] = { ...prev, format: nextFormat };
      this.onChange({ [ref]: { format: nextFormat } });
      this._renderCell(ref);
    }
  }
}
