# Canonical cell data schema

`spreadsheet_history.data` for a tab is always shaped:

```json
{
  "cells": {
    "A1": { "value": "42" },
    "B2": {
      "value": "=SUM(A1:A5)",
      "format": {
        "bold": true, "italic": false, "underline": false,
        "color": "#c00000", "bg": "#ffffff",
        "fontFamily": "serif", "fontSize": "large", "wrap": true
      }
    },
    "C1": { "value": "merged origin", "merge": { "rows": 2, "cols": 3 } }
  },
  "columnWidths": { "A": 120, "C": 80 },
  "rowHeights": { "3": 40 }
}
```

## `cells`

Keyed by A1-style reference (column letters, 1-based row number). Sparse —
a blank cell simply has no key, not an empty entry.

- `value` (string, required): literal text/number, or a formula starting
  with `=`. Formulas are evaluated client-side only (`assets/js/formulas.js`
  — a small recursive-descent parser, not `eval`); nothing server-side
  evaluates them. Functions: `SUM`, `AVG`, `MIN`, `MAX`, `COUNT`, `COUNTA`
  (range functions, one range argument each), `ROUND(value, digits)`,
  `ABS(value)`, `IF(condition, then, else)`, `CONCAT`/`CONCATENATE(...)`
  (variadic string join), plus bare arithmetic (`+ - * /`, parens) and
  comparisons (`= <> < > <= >=`) over cell refs and literals.
- `format` (object, optional): `bold`/`italic`/`underline`/`wrap` (bool),
  `color`/`bg` (CSS color string, text/background), `fontFamily` (one of
  the fixed preset keys in `FONT_FAMILIES`, `assets/js/grid.js` — not a
  free-text CSS value), `fontSize` (one of the fixed preset keys in
  `FONT_SIZES`, same file). Omit the key entirely, or any of its sub-keys,
  when not set.
- `merge` (object, optional): `{"rows": N, "cols": M}` on the top-left
  ("origin") cell of a merged range. Every other cell covered by that
  range has **no entry at all** in `cells` — merging clears/refuses to
  merge over any pre-existing content in those positions (see
  `Grid.mergeSelection()` in `assets/js/grid.js`: refuses if a
  non-origin cell in the target range has content, or if the range
  overlaps an existing merge), so there's never orphaned content sitting
  under a merged region. `Grid._computeCoverage()` derives the covered-cell
  set from every cell's `merge` field each render; nothing else stores
  "this cell is covered by that one."

## `columnWidths` / `rowHeights`

Sparse, top-level, siblings of `cells` — only overridden columns/rows are
present (default width/height applies when absent). Keys are column
letters (`columnWidths`) or 1-based row numbers as strings
(`rowHeights`); values are pixel widths/heights. Set via drag handles in
the grid UI (`Grid._colResizeHandle`/`_rowResizeHandle`).

## Empty-object handling

An empty tab is `{"cells": {}}` — an actual empty *object*, not `[]`. PHP
callers must force this with `(object) []` / `JSON_FORCE_OBJECT` (or
decode with `json_decode($json)`, no `true` flag, so empty objects come
back as `stdClass` instead of indistinguishable-from-array — see
`HistoryRepository`/`Request::inputPreservingObjects()`), since a bare
empty PHP array encodes as a JSON array and the WS server's merge-patch
code, while defensive enough to self-heal from that, shouldn't need to.

## Wire shape / merge patch

This is also the shape the WebSocket server's `new_edit` payloads patch
against (RFC 7396 JSON Merge Patch — see `ws-server/merge_patch.py`):
a patch always merges against the FULL document above (`cells` +
`columnWidths` + `rowHeights`), not just the cells dict, so a patch that
only touches column widths looks like `{"columnWidths": {"A": 140}}`, not
`{"A": 140}`. `Grid`'s public boundary (`onChange` callback, `applyRemote`
input, `setDocument`) is the ONLY place this wrapping/unwrapping happens —
callers (`app.js`) never assemble the wire shape themselves. This is why
it's an object keyed by cell ref (and column letter / row number) rather
than a `rows`/array shape anywhere: merge patch replaces arrays wholesale,
so only an object shape supports patching one cell (or one column width)
without resending the whole document.

A cell's `merge` field forces `Grid` to do a full structural rebuild
(`_build()`, not just `_renderCell()`) on any patch that touches it,
whether local or remote — the table's actual `<td>` layout (which
positions have an element at all, `colspan`/`rowspan` on origins) depends
on the full merge-coverage set, not any single cell in isolation.
