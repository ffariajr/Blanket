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
        "fontFamily": "serif", "fontSize": 16, "wrap": true
      }
    },
    "C1": { "value": "merged origin", "merge": { "rows": 2, "cols": 3 } },
    "D1": { "value": "fernando@example.com", "userinfo": { "field": "email", "autoSaveToCookie": true } }
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
  comparisons (`= <> < > <= >=`) over cell refs and literals. `USERINFO(...)`
  is a formula too, but is NOT one of these functions — it's handled
  entirely separately (see "USERINFO cells" below) and never reaches
  `evaluateFormula()`'s Parser.
- `format` (object, optional): `bold`/`italic`/`underline`/`wrap` (bool),
  `color`/`bg` (CSS color string, text/background), `fontFamily` (one of
  the fixed preset keys in `FONT_FAMILIES`, `assets/js/grid.js` — not a
  free-text CSS value), `fontSize` (a plain number, point size — rendered
  as `fontSize + 'pt'`; the toolbar restricts input to the common sizes
  8–72 in `FONT_SIZES`, `assets/js/grid.js`, but any positive number here
  renders fine if it ever gets here some other way). Omit the key
  entirely, or any of its sub-keys, when not set.
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
- `userinfo` (object, optional): `{"field": "name"|"email", "autoSaveToCookie": true}`.
  Never written directly by a user — it's what a `=USERINFO("", field, true)`
  formula (see below) converts itself into the first time it's rendered.
  Marks this cell as one whose value should keep syncing to a cookie on
  every future edit, not just its initial resolution.

## USERINFO cells

`=USERINFO(buttonLabel, field)` or `=USERINFO(buttonLabel, field, autoSaveToCookie)`
— for self-service sign-up-sheet style cells ("who's bringing what to the
potluck," click a button, your name fills in). Parsed by
`parseUserInfo()` in `assets/js/formulas.js` (reuses the same tokenizer as
every other formula, so quoted-string args parse identically) and rendered
specially by `Grid._renderUserInfoCell()` in `assets/js/grid.js` — it's
checked *before* the normal formula evaluator and never reaches it, because
unlike `SUM` etc. it doesn't reduce to a plain number/string: it changes
cell *rendering* (button vs. plain input) and has side effects tied to the
viewer's identity (cookies), not spreadsheet data.

- `buttonLabel` (string): if non-empty, the cell renders as a clickable
  button showing this text instead of an editable cell.
- `field`: `"name"` or `"email"` today, designed so a third field could be
  added later without restructuring (see `getUserInfoField`/
  `setUserInfoField` in `assets/js/api.js`). `"name"` resolves from the
  JWT's `display_name` if logged in, else the same `blanket_name` cookie
  used by the first-visit name prompt elsewhere in this app (deliberately
  not a second name cookie). `"email"` resolves from a dedicated
  `blanket_userinfo_email` cookie only — there's no account-level email
  available client-side (the JWT doesn't carry it, and there's no
  "fetch my own profile" endpoint), so this cookie *is* the mechanism, not
  a fallback for one.
- `autoSaveToCookie` (bool, 3rd arg, defaults `false`): only meaningful
  when `buttonLabel` is empty (plain-cell mode, below).

**Button mode** (`buttonLabel` non-empty): on click, resolve `field` for
the current viewer. If resolvable, the click is a **one-shot conversion**
— `Grid.setCellValue()` replaces the cell's value with the resolved
literal (e.g. `=USERINFO("Sign Up","name")` becomes the literal text
`"Fernando"`) through the exact same commit path as typing/the formula
bar/paste. The cell is a completely ordinary cell from that point on;
there is no lingering connection to `field` or to USERINFO at all (compare
to plain mode below, where the connection has to persist). If unresolvable
(e.g. an anonymous viewer, `field="email"`, no cookie yet), prompts inline
for it, then uses and stores what they enter the same way `autoSaveToCookie`
would.

**Plain-cell mode** (`buttonLabel` empty, `""`): renders as a normal
editable cell. The *first* time it's rendered, it converts itself (still
one-shot — the raw `=USERINFO(...)` formula text is never kept once
rendered) into `{"value": ..., "userinfo": {"field": ..., "autoSaveToCookie": true}}`
if `autoSaveToCookie` is true — pre-filling `value` from the field's cookie
if one already exists (a real committed value the viewer can edit or
accept, not placeholder ghost text), or leaving `value` empty if not. This
can't collapse straight to a bare literal the way button mode does,
because the cookie-sync has to keep working on every *future* edit too,
not just this first render — so `Grid.setCellValue()` checks for that
lingering `userinfo` marker on every edit going forward and re-syncs the
cookie each time (e.g. correcting a mistyped email keeps the remembered
value current). If `autoSaveToCookie` is `false` (or omitted), the cell
just converts to a bare empty literal with no marker at all — a completely
normal cell, no special behavior.

Two things this deliberately does NOT do, on purpose: clearing a
`userinfo`-tracked cell with Delete/Backspace does not clear the cookie
(routes around `setCellValue()` entirely — see the comment at that call
site in `grid.js`, clearing one cell's *display* of a value shouldn't
erase the viewer's *remembered* value); and pasting into a tracked cell
*does* sync the cookie (it goes through `setCellValue()`, same as typing).

**Rendering a USERINFO formula never itself gets stuck re-firing**: the
one-shot conversion mutates `this.cells[ref]` in `Grid`'s local state
immediately, so any later render of that same ref reads the already-
converted plain value, not the original formula — `parseUserInfo()`
returns `null` on a non-formula string before it even checks the function
name, so `_renderUserInfoCell` simply never runs again for that ref. This
holds across remote patches and structural rebuilds (merge/unmerge
elsewhere in the sheet) too, since both go through the same `this.cells`
state.

**Privacy note, not a bug**: any cell is visible to whoever has view
access to the spreadsheet, including anonymous viewers if the sheet's
anonymous policy allows view. A `field="email"` USERINFO cell on a sheet
with lax anonymous view access broadcasts every signer's email to anyone
who can view it — inherent to a self-service signup sheet as specified,
worth being deliberate about per-sheet access when actually using this.

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
