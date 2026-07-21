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

const REF_RE = /^[A-Z]+\d+/;
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
      const ref = m[0].toUpperCase();
      // Range: REF ':' REF, consumed as one RANGE token.
      const after = rest.slice(m[0].length);
      const rangeMatch = after.match(/^:([A-Z]+\d+)/i);
      if (rangeMatch) {
        tokens.push({ type: 'RANGE', start: ref, end: rangeMatch[1].toUpperCase() });
        i += m[0].length + rangeMatch[0].length;
      } else {
        tokens.push({ type: 'REF', ref });
        i += m[0].length;
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
