// Formula engine: a small recursive-descent parser/evaluator, not a
// general expression language. Grammar:
//   expr     := compare
//   compare  := addsub (('=' | '<>' | '<=' | '>=' | '<' | '>') addsub)?
//   addsub   := term (('+' | '-') term)*
//   term     := factor (('*' | '/') factor)*
//   factor   := NUMBER | STRING | REF | '(' expr ')' | funcCall | '-' factor
//   funcCall := IDENT '(' (arg (',' arg)*)? ')'
//   arg      := RANGE | expr
// Values are number | string throughout (no separate boolean type --
// comparisons evaluate to 1/0, which is what IF's condition consumes).
// Deliberately not eval()/Function()-based anywhere: every value flowing
// through here is a parsed token, never a raw string handed to a JS
// evaluator, so there's no formula-injection surface.

const RANGE_FNS = new Set(['SUM', 'AVG', 'MIN', 'MAX', 'COUNT', 'COUNTA']);
const SCALAR_FNS = new Set(['ROUND', 'ABS', 'IF', 'CONCAT', 'CONCATENATE']);

export function isFormula(value) {
  return typeof value === 'string' && value.startsWith('=');
}

/**
 * Parses `=USERINFO(buttonLabel, field[, autoSaveToCookie])` specifically.
 * Unlike every other function in this file, USERINFO doesn't reduce to a
 * plain number|string (it changes cell *rendering* -- button vs. plain
 * input -- with side effects tied to the viewer's identity, not spreadsheet
 * data), so it can't go through evaluateFormula()'s Parser/applyFunction
 * path, which only ever returns scalars. grid.js checks this FIRST and
 * only falls through to evaluateFormula() for everything else -- see
 * CELL_SCHEMA.md.
 *
 * Reuses the same tokenize() everything else here uses, so quoted string
 * args parse identically to any other function call (whitespace, escaping
 * quirks, etc. all shared) -- it just extracts the raw args instead of
 * computing a result from them. USERINFO's arguments are always literal
 * strings/booleans, never expressions/refs/ranges, so this doesn't need
 * the full Parser, just a flat walk of the same token stream.
 *
 * @returns {{buttonLabel: string, field: string, autoSaveToCookie: boolean}|null}
 *   null if `formula` isn't a well-formed USERINFO(...) call -- grid.js
 *   falls through to the normal formula evaluator (which will itself
 *   produce #ERROR for a bare `=USERINFO(...)` used incorrectly, e.g.
 *   nested inside another function -- USERINFO is intentionally not in
 *   RANGE_FNS/SCALAR_FNS below, so that's already the correct behavior).
 */
export function parseUserInfo(formula) {
  if (!isFormula(formula)) return null;
  let tokens;
  try {
    tokens = tokenize(formula.slice(1));
  } catch {
    return null;
  }
  if (tokens.length < 4) return null;
  if (tokens[0].type !== 'IDENT' || tokens[0].name !== 'USERINFO') return null;
  if (tokens[1].type !== 'OP' || tokens[1].value !== '(') return null;

  const args = [];
  let i = 2;
  let expectComma = false;
  for (; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === 'OP' && t.value === ')') { i++; break; }
    if (expectComma) {
      if (t.type !== 'OP' || t.value !== ',') return null;
      expectComma = false;
      continue;
    }
    if (t.type === 'STRING') { args.push(t.value); expectComma = true; continue; }
    if (t.type === 'IDENT' && (t.name === 'TRUE' || t.name === 'FALSE')) {
      args.push(t.name === 'TRUE'); expectComma = true; continue;
    }
    return null; // a ref/range/number/nested call -- not a valid USERINFO arg
  }
  if (i !== tokens.length) return null; // trailing garbage after the closing paren
  if (args.length < 2 || args.length > 3) return null;
  if (typeof args[0] !== 'string' || typeof args[1] !== 'string') return null;

  return {
    buttonLabel: args[0],
    field: args[1],
    autoSaveToCookie: args.length > 2 ? !!args[2] : false,
  };
}

/**
 * @param {string} formula e.g. "=SUM(A1:A5)" or "=IF(A1>10,\"big\",\"small\")"
 * @param {(ref: string) => (number|string)} resolveRef resolves a cell ref
 *   to its current evaluated value (0 if blank/non-numeric-and-non-string
 *   is up to the caller; the grid supplies this so the engine doesn't need
 *   to know about the document shape).
 * @returns {number|string} the computed value, or "#ERROR" on failure.
 */
export function evaluateFormula(formula, resolveRef) {
  try {
    const tokens = tokenize(formula.slice(1));
    const parser = new Parser(tokens, resolveRef);
    const result = parser.parseExpr();
    if (!parser.atEnd()) return '#ERROR';
    return result;
  } catch {
    return '#ERROR';
  }
}

// --- Tokenizer ---------------------------------------------------------

// Optional '$' before the column letters and/or before the row digits,
// independently -- A1, $A1, A$1, $A$1 all match. The '$' is stripped
// before the ref/start/end fields below are ever used for resolution
// (evaluateFormula/resolveRef), so a $-locked reference evaluates
// identically to its unlocked form -- '$' only affects
// shiftFormulaReferences() below (copy/paste), never a computed value.
const REF_RE = /^\$?[A-Z]+\$?\d+/;
const RANGE_END_RE = /^:(\$?[A-Z]+\$?\d+)/i;
const IDENT_RE = /^[A-Z][A-Z0-9_]*/i;
const NUMBER_RE = /^\d+(\.\d+)?/;

function tokenize(src) {
  const s = src.trim();
  const tokens = [];
  let i = 0;
  while (i < s.length) {
    const rest = s.slice(i);
    const ch = rest[0];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '"') {
      const end = rest.indexOf('"', 1);
      if (end === -1) throw new Error('unterminated string');
      tokens.push({ type: 'STRING', value: rest.slice(1, end) });
      i += end + 1;
      continue;
    }
    let m;
    if ((m = rest.match(NUMBER_RE))) {
      tokens.push({ type: 'NUMBER', value: parseFloat(m[0]) });
      i += m[0].length;
      continue;
    }
    if ((m = rest.match(REF_RE))) {
      const raw = m[0];
      const ref = raw.replace(/\$/g, '').toUpperCase();
      // Range: REF ':' REF, consumed as one RANGE token.
      const after = rest.slice(raw.length);
      const rangeMatch = after.match(RANGE_END_RE);
      if (rangeMatch) {
        const end = rangeMatch[1].replace(/\$/g, '').toUpperCase();
        tokens.push({ type: 'RANGE', start: ref, end });
        i += raw.length + rangeMatch[0].length;
      } else {
        tokens.push({ type: 'REF', ref });
        i += raw.length;
      }
      continue;
    }
    if ((m = rest.match(IDENT_RE))) {
      tokens.push({ type: 'IDENT', name: m[0].toUpperCase() });
      i += m[0].length;
      continue;
    }
    if (rest.startsWith('<>')) { tokens.push({ type: 'OP', value: '<>' }); i += 2; continue; }
    if (rest.startsWith('<=')) { tokens.push({ type: 'OP', value: '<=' }); i += 2; continue; }
    if (rest.startsWith('>=')) { tokens.push({ type: 'OP', value: '>=' }); i += 2; continue; }
    if ('+-*/()=<>,'.includes(ch)) { tokens.push({ type: 'OP', value: ch }); i++; continue; }
    throw new Error(`unexpected character: ${ch}`);
  }
  return tokens;
}

// --- Parser + evaluator (combined -- each parse* returns a value, not an AST) ---

class Parser {
  constructor(tokens, resolveRef) {
    this.tokens = tokens;
    this.pos = 0;
    this.resolveRef = resolveRef;
  }

  atEnd() {
    return this.pos >= this.tokens.length;
  }

  peek() {
    return this.tokens[this.pos];
  }

  next() {
    return this.tokens[this.pos++];
  }

  expectOp(value) {
    const t = this.next();
    if (!t || t.type !== 'OP' || t.value !== value) throw new Error(`expected '${value}'`);
  }

  parseExpr() {
    return this.parseCompare();
  }

  parseCompare() {
    const left = this.parseAddSub();
    const t = this.peek();
    if (t && t.type === 'OP' && ['=', '<>', '<=', '>=', '<', '>'].includes(t.value)) {
      this.next();
      const right = this.parseAddSub();
      return compareValues(t.value, left, right) ? 1 : 0;
    }
    return left;
  }

  parseAddSub() {
    let left = this.parseTerm();
    for (;;) {
      const t = this.peek();
      if (t && t.type === 'OP' && (t.value === '+' || t.value === '-')) {
        this.next();
        const right = this.parseTerm();
        left = t.value === '+' ? toNumber(left) + toNumber(right) : toNumber(left) - toNumber(right);
      } else {
        return left;
      }
    }
  }

  parseTerm() {
    let left = this.parseFactor();
    for (;;) {
      const t = this.peek();
      if (t && t.type === 'OP' && (t.value === '*' || t.value === '/')) {
        this.next();
        const right = this.parseFactor();
        if (t.value === '*') {
          left = toNumber(left) * toNumber(right);
        } else {
          if (toNumber(right) === 0) throw new Error('div by zero'); // -> #ERROR at the top level
          left = toNumber(left) / toNumber(right);
        }
      } else {
        return left;
      }
    }
  }

  parseFactor() {
    const t = this.next();
    if (!t) throw new Error('unexpected end');
    if (t.type === 'NUMBER') return t.value;
    if (t.type === 'STRING') return t.value;
    if (t.type === 'OP' && t.value === '-') return -toNumber(this.parseFactor());
    if (t.type === 'OP' && t.value === '(') {
      const v = this.parseExpr();
      this.expectOp(')');
      return v;
    }
    if (t.type === 'REF') return this.resolveRef(t.ref);
    if (t.type === 'IDENT') return this.parseCall(t.name);
    throw new Error('unexpected token');
  }

  parseCall(name) {
    this.expectOp('(');
    const args = [];
    if (!(this.peek() && this.peek().type === 'OP' && this.peek().value === ')')) {
      for (;;) {
        args.push(this.parseArg());
        const t = this.peek();
        if (t && t.type === 'OP' && t.value === ',') { this.next(); continue; }
        break;
      }
    }
    this.expectOp(')');
    return this.applyFunction(name, args);
  }

  // An arg is either a RANGE token (kept as {ref list}) or a fully
  // evaluated expr value -- ranges are only meaningful to range functions,
  // resolved lazily there so a bare RANGE never leaks into arithmetic.
  parseArg() {
    if (this.peek() && this.peek().type === 'RANGE') {
      const t = this.next();
      return { __range: expandRange(t.start, t.end) };
    }
    return this.parseExpr();
  }

  applyFunction(name, args) {
    if (RANGE_FNS.has(name)) {
      if (args.length !== 1 || !args[0] || !args[0].__range) throw new Error(`${name} expects a single range`);
      const refs = args[0].__range;
      const raw = refs.map((r) => this.resolveRef(r));
      return applyRangeFn(name, raw);
    }
    if (SCALAR_FNS.has(name)) {
      const scalars = args.map((a) => (a && a.__range ? '#ERROR' : a));
      return applyScalarFn(name, scalars);
    }
    throw new Error(`unknown function: ${name}`);
  }
}

function applyRangeFn(fn, rawValues) {
  const nums = rawValues.map(toNumber).filter((v) => !isNaN(v));
  switch (fn) {
    case 'SUM': return nums.reduce((a, b) => a + b, 0);
    case 'AVG': return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
    case 'MIN': return nums.length ? Math.min(...nums) : 0;
    case 'MAX': return nums.length ? Math.max(...nums) : 0;
    case 'COUNT': return nums.length;
    case 'COUNTA': return rawValues.filter((v) => v !== '' && v !== null && v !== undefined).length;
    default: return '#ERROR';
  }
}

function applyScalarFn(fn, args) {
  switch (fn) {
    case 'ROUND': {
      const digits = args.length > 1 ? Math.max(0, Math.trunc(toNumber(args[1]))) : 0;
      const factor = Math.pow(10, digits);
      return Math.round(toNumber(args[0]) * factor) / factor;
    }
    case 'ABS':
      return Math.abs(toNumber(args[0]));
    case 'IF':
      if (args.length < 2) return '#ERROR';
      return toNumber(args[0]) !== 0 ? args[1] : (args.length > 2 ? args[2] : '');
    case 'CONCAT':
    case 'CONCATENATE':
      return args.map(toDisplayString).join('');
    default:
      return '#ERROR';
  }
}

function compareValues(op, a, b) {
  const bothNumeric = !isNaN(toNumber(a)) && !isNaN(toNumber(b)) && typeof a !== 'string' || (typeof a === 'string' && a.trim() !== '' && !isNaN(parseFloat(a)));
  const na = toNumber(a), nb = toNumber(b);
  const useNumeric = !isNaN(na) && !isNaN(nb) && (typeof a !== 'string' || a.trim() !== '') && (typeof b !== 'string' || b.trim() !== '');
  const left = useNumeric ? na : toDisplayString(a);
  const right = useNumeric ? nb : toDisplayString(b);
  switch (op) {
    case '=': return left === right;
    case '<>': return left !== right;
    case '<': return left < right;
    case '>': return left > right;
    case '<=': return left <= right;
    case '>=': return left >= right;
    default: return false;
  }
}

function toNumber(v) {
  if (typeof v === 'number') return v;
  const n = parseFloat(v);
  return isNaN(n) ? NaN : n;
}

function toDisplayString(v) {
  return v === undefined || v === null ? '' : String(v);
}

// --- Ref/range helpers (also used by grid.js for its own range needs) --

export function parseRef(ref) {
  const m = ref.match(/^([A-Z]+)(\d+)$/i);
  const letters = m[1].toUpperCase();
  let col = 0;
  for (const ch of letters) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { col: col - 1, row: parseInt(m[2], 10) - 1 };
}

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

/**
 * Excel-style copy/paste reference shifting. When a formula is copied from
 * one cell and pasted into another, every reference in it shifts by the
 * (column, row) delta between source and destination -- except any
 * component locked with '$', which stays fixed. '$' has zero effect on
 * evaluation (see the REF_RE comment above); this is the only place it
 * matters.
 *
 * Worked example: copying `=CONCAT($A1, A$3, B4)` from C5 to D6 (delta:
 * +1 col, +1 row) produces `=CONCAT($A2, B$3, C5)` -- $A1's column is
 * locked (stays A) but its row is relative (1->2); A$3's column is
 * relative (A->B) but its row is locked (stays 3); B4 is fully relative
 * (->C5).
 *
 * Scans the formula text directly (not the token stream) so every other
 * character -- operators, function names, number literal formatting,
 * whitespace -- is preserved byte-for-byte; only REF-shaped substrings
 * outside string literals are touched. Matches the exact same
 * letters+digits pattern the tokenizer treats as a ref, so this can never
 * disagree with how the formula actually parses. If any reference would
 * shift before column A or row 1, the whole formula becomes `=#REF!`,
 * matching Excel (a formula referencing a cell that no longer exists is
 * entirely invalid, not just that one argument).
 *
 * @param {string} formula
 * @param {number} deltaCols
 * @param {number} deltaRows
 * @returns {string} unchanged if `formula` isn't a formula, or has no
 *   references, or deltaCols/deltaRows are both 0.
 */
export function shiftFormulaReferences(formula, deltaCols, deltaRows) {
  if (!isFormula(formula)) return formula;
  const body = formula.slice(1);
  let out = '';
  let i = 0;
  let refError = false;
  while (i < body.length) {
    const ch = body[i];
    if (ch === '"') {
      const end = body.indexOf('"', i + 1);
      const stop = end === -1 ? body.length : end + 1;
      out += body.slice(i, stop);
      i = stop;
      continue;
    }
    const rest = body.slice(i);
    const m = rest.match(/^(\$?)([A-Z]+)(\$?)(\d+)/i);
    if (m) {
      const [full, colDollar, letters, rowDollar, digits] = m;
      const { col, row } = parseRef(letters.toUpperCase() + digits);
      const newCol = colDollar ? col : col + deltaCols;
      const newRow = rowDollar ? row : row + deltaRows;
      if (newCol < 0 || newRow < 0) {
        refError = true;
        out += full;
      } else {
        out += `${colDollar}${colLetter(newCol)}${rowDollar}${newRow + 1}`;
      }
      i += full.length;
      continue;
    }
    out += ch;
    i++;
  }
  return refError ? '=#REF!' : '=' + out;
}

/**
 * Reference adjustment for inserting/deleting rows or columns -- a
 * different transform than shiftFormulaReferences() above (copy/paste):
 * that one shifts every reference in ONE formula by a uniform delta
 * because the CELL ITSELF moved. This one is applied to EVERY formula in
 * the whole document (a cell whose own position never changed can still
 * reference something that did), and '$' locking is irrelevant here --
 * $ only matters for "does this reference move when the formula itself is
 * copied elsewhere," not "does this reference move when some other row/
 * column is structurally inserted or removed." A locked and unlocked
 * reference to the same cell shift identically; '$' characters are kept
 * in the output as literal text, just never consulted for the shift
 * decision.
 *
 * insert: every reference at/after boundaryIndex (in `dimension`) shifts
 * by +count.
 * delete: every reference inside [boundaryIndex, boundaryIndex+count)
 * invalidates the whole formula to `=#REF!` (matching Excel -- a formula
 * referencing a row/column that no longer exists is wholly invalid);
 * every reference at/after boundaryIndex+count shifts by -count;
 * anything before boundaryIndex is untouched.
 *
 * Deliberately not attempting full dependency-graph correctness (e.g. a
 * RANGE whose start and end land on opposite sides of a delete boundary
 * collapsing sensibly) -- this is a best-effort pass, not a spreadsheet-
 * engine-grade implementation. Get the common cases right; edge cases
 * fall back to #REF! rather than silently computing something wrong.
 *
 * @param {string} formula
 * @param {'row'|'col'} dimension
 * @param {number} boundaryIndex 0-indexed row/col where the change starts
 * @param {number} count how many rows/cols were inserted or removed
 * @param {boolean} isInsert
 * @returns {string} unchanged if `formula` isn't a formula
 */
export function shiftReferencesForStructuralChange(formula, dimension, boundaryIndex, count, isInsert) {
  if (!isFormula(formula)) return formula;
  const body = formula.slice(1);
  let out = '';
  let i = 0;
  let refError = false;
  while (i < body.length) {
    const ch = body[i];
    if (ch === '"') {
      const end = body.indexOf('"', i + 1);
      const stop = end === -1 ? body.length : end + 1;
      out += body.slice(i, stop);
      i = stop;
      continue;
    }
    const rest = body.slice(i);
    const m = rest.match(/^(\$?)([A-Z]+)(\$?)(\d+)/i);
    if (m) {
      const [full, colDollar, letters, rowDollar, digits] = m;
      const { col, row } = parseRef(letters.toUpperCase() + digits);
      const idx = dimension === 'row' ? row : col;
      let newIdx = idx;
      if (isInsert) {
        if (idx >= boundaryIndex) newIdx = idx + count;
      } else if (idx >= boundaryIndex && idx < boundaryIndex + count) {
        refError = true;
      } else if (idx >= boundaryIndex + count) {
        newIdx = idx - count;
      }
      if (refError) {
        out += full; // whole formula becomes #REF! below regardless of this text
      } else {
        const newRow = dimension === 'row' ? newIdx : row;
        const newCol = dimension === 'col' ? newIdx : col;
        out += `${colDollar}${colLetter(newCol)}${rowDollar}${newRow + 1}`;
      }
      i += full.length;
      continue;
    }
    out += ch;
    i++;
  }
  return refError ? '=#REF!' : '=' + out;
}

export function expandRange(startRef, endRef) {
  const a = parseRef(startRef);
  const b = parseRef(endRef);
  const refs = [];
  for (let r = Math.min(a.row, b.row); r <= Math.max(a.row, b.row); r++) {
    for (let c = Math.min(a.col, b.col); c <= Math.max(a.col, b.col); c++) {
      refs.push(colLetter(c) + (r + 1));
    }
  }
  return refs;
}
