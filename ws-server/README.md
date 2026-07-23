# Blanket WebSocket server

Real-time collaborative editing. Deployed independently of the PHP app
(not synced by `install.sh`, not under `/var/www` -- runs as its own
process, reverse-proxied by Apache via `mod_proxy_wstunnel`, per
`REQUIREMENTS.md`).

## Setup

```
python3 -m venv venv
venv/bin/pip install -r requirements.txt
```

Reads `.mysql.env` and `.app.env` from the repo root (same files the PHP
app uses -- see `src/Config.php`). No config of its own beyond that.

## Run

```
venv/bin/python3 server.py
```

Listens on `127.0.0.1:8765` (localhost-only, matching the existing
`api.dogmanjr.net` Flask pattern in `MACHINE.md` -- Apache is the only
externally-facing listener). Flushes all sessions with unsaved changes on
`SIGTERM`/`SIGINT` before exiting.

## Wire protocol

Connect: `ws://host:port/ws/tabs/{tab_id}`.

First message from the client MUST be `hello`:
```json
{"type": "hello", "name": "Display name", "token": "<JWT>"}
```
`token` is optional -- omit it, or send an invalid/expired one, to connect
as the anonymous sentinel user, id 0. Carried here rather than as a
`?token=` query param on the connect URL so it never ends up in Apache's
access log (which only ever sees the initial HTTP upgrade request line,
never message frames sent after). `name` is REQUIRED when connecting
anonymously (the frontend's "what's your name?" prompt, stored
client-side in a cookie per the product design). Ignored when
authenticated -- the display name comes from the JWT's `display_name`
claim instead.

Client -> server, after `hello`:
- `{"type": "keystroke", "payload": <anything>}` -- pure ephemeral relay
  to other clients on the same tab_id. Never touches the document or the
  database. Silently dropped if the sender is view-only.
- `{"type": "new_edit", "payload": <JSON Merge Patch, RFC 7396>}` --
  applied to the in-memory document immediately (via
  `merge_patch.apply_merge_patch`), then rebroadcast to other clients.
  Rejected with an `error` reply if the sender is view-only. This is a
  **design decision made here, not specified beforehand**: the live wire
  payload is a merge patch (small, e.g.
  `{"cells": {"A1": {"value": "hello"}}}`, a key set to `null` deletes it)
  so it stays small regardless of document size -- but what gets
  *persisted* is always the resulting full document, never the patch
  itself, per the earlier decision to drop the edit-log/delta persistence
  design. The frontend must produce patches in this shape.
- `{"type": "save"}` -- forces an immediate persist if there are unsaved
  changes.
- `{"type": "presence_active", "active": true|false}` -- reports a page-
  visibility/idle-timer change (the actual visibility/focus/interaction
  logic that decides when to send this is a frontend concern, not this
  server's -- see `presence.py`'s module docstring). Triggers a `presence`
  rebroadcast to the whole spreadsheet, not just this tab.
- `{"type": "selection", "selection": {"anchor": "A1", "selected": "B3"} | null}`
  -- reports the sender's current cell/range selection (`anchor ===
  selected` for a single cell; `null` for nothing selected). Same
  rebroadcast.

Server -> client:
- `{"type": "state", "sequence": N, "data": {...}}` -- sent once, right
  after `hello`: the tab's current full document (`{}` if the tab has no
  history yet).
- `{"type": "new_edit", "from": {"user_id":.., "name":".."}, "payload": {...}}`
- `{"type": "keystroke", "from": {...}, "payload": {...}}`
- `{"type": "saved", "sequence": N}` -- a persist just happened.
- `{"type": "error", "message": "..."}`
- `{"type": "presence", "viewers": [{"connection_id":.., "user_id":..,
  "name":.., "is_anonymous":.., "color":"#rrggbb", "tab_id":..,
  "selection":{...}|null, "active":.., "last_active_at":<epoch seconds>},
  ...]}` -- see "Presence" below.

## Presence

Fernando's ask: show who's viewing a spreadsheet, what they've selected,
an active/idle state, and a distinct color reused for their name and
selection highlight -- spanning the *whole spreadsheet*, not just the
current tab (someone on a different tab of the same spreadsheet should
still show up, tagged with which tab they're on).

Implemented in `presence.py` as `SpreadsheetPresence`, a registry keyed by
`spreadsheet_id` (one per currently-open spreadsheet, created on first
connect and torn down when the last viewer of that spreadsheet leaves) --
deliberately separate from `TabSession` (`session.py`), which stays scoped
per `tab_id` and owns the actual document/persistence. `spreadsheet_id` is
already resolved once at connect time by `access.resolve()` for the
permission check; presence reuses that same value rather than requerying.

A viewer is added to their spreadsheet's registry on connect (`hello`
succeeding) and removed on disconnect. Every `presence_active`/`selection`
message, and every connect/disconnect, triggers a full-roster rebroadcast
(`{"type": "presence", "viewers": [...]}`) to *every* connection across
*every* tab of that spreadsheet -- not a diff, and not scoped to just the
sender's own tab_id. A client filters client-side: viewers whose `tab_id`
matches the tab it's currently looking at get full selection-highlight
treatment; viewers on other tabs just contribute their `color` to that
tab's entry in the tab bar.

**Color assignment**: a fixed 12-color palette (`presence._PALETTE`),
scoped per spreadsheet registry (two different spreadsheets can reuse the
same color for different people -- only viewers of the *same* spreadsheet
need to be distinguishable from each other). The first color not already
in use by another connection on that spreadsheet is assigned on connect,
freed on disconnect; if concurrent viewers ever exceed the palette (not a
realistic scenario at this app's scale), colors cycle/reuse rather than
erroring.

**Active/idle**: this server only stores and rebroadcasts whatever
`active` boolean the client reports -- the actual page-visibility/focus/
interaction-timer logic that decides *when* to send `presence_active` is
entirely a frontend concern. `last_active_at` updates only when `active`
actually transitions (not on every message received) -- it means "last
time this viewer was confirmed active," not "last time we heard from
them at all."

**Identity**: `user_id`/`name`/`is_anonymous` come from the same
`auth.resolve_identity()` result already used for save attribution
elsewhere -- nothing new to resolve, just surfaced in presence entries.

## Persistence / durability

Throttled, not per-edit, per the earlier design: at most one write every
5s after the last edit (trailing debounce), forced at least every 15s
during continuous editing, forced immediately when the last client
disconnects from a tab, forced on an explicit `save` message, and flushed
on graceful shutdown. See `session.py`'s module docstring and
`TabSession._flush_if_dirty`.

Attribution (`saved_by`/`saved_by_ip`/`saved_by_name`) is taken from
whoever sent the most recent accepted `new_edit` before the flush fires --
"who was responsible for this snapshot" = the last editor, tracked as
`TabSession.last_editor`. Not specified beforehand; this is the convention
chosen here.

Access level (owner/admin -> edit; otherwise the higher of an explicit
`spreadsheet_access` row and the spreadsheet's anonymous policy row) is
resolved once at connect time -- see `access.py`'s module docstring for
the precedence rule, also decided here since nothing specified it. A
logged-in user with no explicit grant still gets at least whatever the
anonymous policy allows.

## A bug worth knowing about (fixed, but the shape of it matters)

The debounce/max-wait timers originally never fired on their own --
`_flush_if_dirty`, when invoked *by* the debounce timer task itself, was
cancelling `self.debounce_task`, which at that point *was* the currently
running task (itself), throwing `CancelledError` into its own persist
before the DB write completed. Every persist in testing was silently only
ever happening via the disconnect path, never the timer. Fixed by checking
`task is not asyncio.current_task()` before cancelling in
`TabSession._flush_if_dirty`. Worth remembering if this pattern
(a scheduled task cancelling "the pending timer" from inside a call stack
that might itself *be* that timer) shows up again.

## A cross-cutting fix made here

`src/Auth/Jwt.php` encoded the `sub` claim as a JSON number. PyJWT (used
here to verify PHP-issued tokens) enforces RFC 7519's requirement that
`sub` be a `StringOrURI` and rejects a numeric `sub` with
`InvalidSubjectError` -- this wasn't just a test-fixture mismatch, it would
have broken every real PHP-issued token against this server. Fixed in
`Jwt::issue()` by casting to `(string)`; `Authenticator`/`CurrentUser`
already cast back to `int`, so this is a safe, compatible change on the
PHP side too.

## Manual test harness

No automated test framework is wired up yet. `test_fixtures.sql` creates
throwaway users/spreadsheets/tabs (delete afterward -- see the `DELETE`
statements in the git history of this file's introducing commit for the
exact cleanup used), `gen_test_token.py` mints a JWT for a given user id
without going through the PHP login flow, and `test_client.py` drives six
scenarios end-to-end (collab relay + debounce persist, explicit save,
max-wait persist under continuous editing, disconnect-flush, anonymous
rejection, anonymous view-only). Run the server, load the fixtures, run
`gen_test_token.py` for the fixture user ids into files, then
`venv/bin/python3 test_client.py`.
