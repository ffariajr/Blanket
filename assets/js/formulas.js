// Minimal formula engine: =SUM(A1:A5), =AVG(...), =MIN(...), =MAX(...),
// =COUNT(...), plus bare arithmetic over cell refs, e.g. =A1+B2*2.
// Deliberately not a general expression engine -- five range functions and
// basic arithmetic, per the README's "basic formula support."

const RANGE_FN = /^(SUM|AVG|MIN|MAX|COUNT)\(([A-Z]+\d+):([A-Z]+\d+)\)$/i;
const CELL_REF = /[A-Z]+\d+/g;

export function isFormula(value) {
  return typeof value === 'string' && value.startsWith('=');
}

/**
 * @param {string} formula e.g. "=SUM(A1:A5)"
 * @param {(ref: string) => number} getNumericValue resolves a cell ref to
 *   its current numeric value (0 if blank/non-numeric); the grid supplies
 *   this so the engine doesn't need to know about the document shape.
 * @returns {number|string} the computed value, or "#ERROR" on failure.
 */
export function evaluateFormula(formula, getNumericValue) {
  const expr = formula.slice(1).trim();

  const rangeMatch = expr.match(RANGE_FN);
  if (rangeMatch) {
    const [, fn, startRef, endRef] = rangeMatch;
    const values = expandRange(startRef, endRef).map(getNumericValue);
    return applyRangeFn(fn.toUpperCase(), values);
  }

  // Bare arithmetic: substitute cell refs with their numeric values, then
  // evaluate a restricted expression (digits, refs already substituted,
  // + - * / ( ) . and whitespace only -- never passed to eval-like
  // execution of the original string).
  const substituted = expr.replace(CELL_REF, (ref) => String(getNumericValue(ref)));
  if (!/^[0-9+\-*/().\s]*$/.test(substituted)) {
    return '#ERROR';
  }
  try {
    // Safe: substituted is already validated to contain only numeric/
    // arithmetic characters, no identifiers, no function calls.
    const result = Function(`"use strict"; return (${substituted || '0'});`)();
    return typeof result === 'number' && isFinite(result) ? result : '#ERROR';
  } catch {
    return '#ERROR';
  }
}

function applyRangeFn(fn, values) {
  const nums = values.filter((v) => typeof v === 'number' && !isNaN(v));
  switch (fn) {
    case 'SUM':
      return nums.reduce((a, b) => a + b, 0);
    case 'AVG':
      return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
    case 'MIN':
      return nums.length ? Math.min(...nums) : 0;
    case 'MAX':
      return nums.length ? Math.max(...nums) : 0;
    case 'COUNT':
      return nums.length;
    default:
      return '#ERROR';
  }
}

function parseRef(ref) {
  const m = ref.match(/^([A-Z]+)(\d+)$/i);
  const letters = m[1].toUpperCase();
  let col = 0;
  for (const ch of letters) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { col: col - 1, row: parseInt(m[2], 10) - 1 };
}

function colLetter(index) {
  let letter = '';
  index++;
  while (index > 0) {
    const rem = (index - 1) % 26;
    letter = String.fromCharCode(65 + rem) + letter;
    index = Math.floor((index - 1) / 26);
  }
  return letter;
}

function expandRange(startRef, endRef) {
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
