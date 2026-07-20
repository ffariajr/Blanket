# Canonical cell data schema

`spreadsheet_history.data` for a tab is always shaped:

```json
{
  "cells": {
    "A1": { "value": "42" },
    "B2": { "value": "=SUM(A1:A5)", "format": { "bold": true, "color": "#c00000" } }
  }
}
```

- Keyed by A1-style reference (column letters, 1-based row number). Sparse —
  a blank cell simply has no key, not an empty entry.
- `value` (string, required): literal text/number, or a formula starting
  with `=`. Formulas are evaluated client-side only (SUM/AVG/MIN/MAX/COUNT
  over a range); nothing server-side evaluates them.
- `format` (object, optional): any of `bold` (bool), `italic` (bool),
  `color` (CSS color string, text), `bg` (CSS color string, background).
  Omit the key entirely, or any of its sub-keys, when not set.

An empty tab is `{"cells": {}}` — an actual empty *object*, not `[]`. PHP
callers must force this with `(object) []` / `JSON_FORCE_OBJECT`, since a
bare empty PHP array encodes as a JSON array and the WS server's merge-patch
code, while defensive enough to self-heal from that, shouldn't need to.

This is also the shape the WebSocket server's `new_edit` payloads patch
against (RFC 7396 JSON Merge Patch — see `ws-server/merge_patch.py`), which
is why it's an object keyed by cell ref rather than a `rows` array: merge
patch replaces arrays wholesale, so only an object shape supports patching
one cell without resending the whole document.
