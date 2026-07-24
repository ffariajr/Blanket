# Blanket — Pre-Release Testing Plan

**Purpose:** Fernando is about to release Blanket to real clients — production-facing,
real users, real reputational stakes, not internal-only anymore. This is the
gate. **If everything in this plan passes (or every finding is triaged and
accepted/fixed), the only remaining step is narrowing the `blanket` MySQL
user's grants (already scheduled, `TODO.md`), then release.**

This document is a plan, not an execution log. A separate agent reads this
and dispatches the actual test execution (almost certainly via the `Workflow`
tool, fanning out many subagents per section). **Every bug found during
execution goes in `/home/claude/blanket/BUGS_FOUND.md`, not inline fixes** —
the explicit exception is the two pre-identified bugs in Section G, which
should be root-caused and fixed this round, not just re-discovered and logged
again. Everything else: record, don't fix, so Fernando can triage before
deciding what blocks release.

## Scale warning, read this before starting

This is **not** a single afternoon's work and should not be run as one
`Workflow` call. Six genuinely distinct areas (full functional regression,
mobile parity, security, performance, a full WS-collaborator-count matrix,
plus two bugs to actually fix) each warrant their own `Workflow` invocation
with its own dimension breakdown, run **sequentially or in a deliberately
staged order** (see "Suggested sequencing" at the end), not crammed into one
mega-script. Treat each major section below as its own `Workflow` call at
minimum; some (Section A, Section E) likely warrant more than one. Err
toward thoroughness — this is exactly the wrong place to cut scope to save
time, per Fernando's own stated purpose.

## Ground rules (apply to every section, every agent)

- **Never touch spreadsheet id=13** ("Test", owner id=15 `fvf`) or its
  tabs/history/access. Every agent creates its own throwaway users/
  spreadsheets.
- **Naming: collision-resistant, not a fill-in-the-blank template.** Read the
  `concurrent_test_data_collisions` project memory — two different classes of
  test-data collision have actually happened this session (a broad `LIKE`
  cleanup hitting a sibling's still-in-use rows, and multiple agents
  independently completing an identical literal username template). Every
  agent must generate its own random suffix (e.g. `openssl rand -hex 4`) for
  its throwaway usernames/titles, not fill in a shared template the same
  predictable way another concurrent agent might.
- **Cleanup: exact ID only, never `LIKE`.** No exceptions, even for "my own"
  prefix.
- **Real browser, not jsdom, wherever the finding could plausibly be a
  rendering/layout/timing issue.** Read the `browser-testing-workaround`
  project memory: a cached Chromium binary works on this box without root by
  extracting 4 missing shared libs via `apt-get download` + `dpkg-deb -x`,
  driven directly via `puppeteer-core` (NOT the `mcp__*__browser_*` MCP
  tools, which spawn their own Chrome process and don't inherit a shell's
  `LD_LIBRARY_PATH`). jsdom is fine for pure-logic checks (formula
  evaluation, dependency graphs) where no real layout/timing/clipboard is
  involved.
- **Every finding recorded in `BUGS_FOUND.md`** using the template already in
  that file — severity, area, precise reproduction, whether it was adversarially
  re-verified by a second agent (do this for every finding, same pattern as
  prior testing rounds in this project: a finder proposes, a different agent
  tries to independently reproduce before it counts as confirmed).
- **This app has changed substantially since the last full functional sweep**
  — formula copy/paste clipboard race fix, `ACTIONGROUP` reference-deletion
  handling, cookie-clearing-on-clear behavior, arrow-key cell traversal,
  vertical scroll fix, WS auth moved to the `hello` message, Origin
  validation, and the entire mobile bug batch (touch drag-select, topbar
  layout, Share dialog, sheets-list overflow, Manage Tabs button size). Don't
  assume anything not explicitly listed as "already re-verified" is still
  correct — a full regression sweep is warranted, not spot-checks.
- **Already known and deliberately accepted — do NOT re-flag as findings:**
  no login rate-limiting (Fernando explicitly declined this); the `blanket`
  MySQL user currently has `ALL PRIVILEGES` (already tracked, scheduled to be
  narrowed as the literal next step after this testing passes).

---

## Section A — Full functional regression sweep (web/desktop)

Re-test the whole feature surface given how much has changed since the last
full pass. Suggested breakdown (mirrors the dimension structure of the
original exhaustive-test workflow, which worked well):

1. **Auth & permissions.** Login success/failure, JWT expiry AND the 6-month
   sliding renewal (`POST /api/session/renew`, seeded silently for a
   logged-in user with no cookie, required dialog only for anonymous with no
   cookie), the permissive anonymous-fallback change (commit `0431c71`: a
   logged-in user with no explicit grant now inherits the anon policy,
   max(explicit, anon) — re-verify `canManage()`/tab-structure ops are STILL
   strictly owner/admin-only regardless of this), full owner/editor/viewer
   matrix, WS auth via the `hello` message (`e2c26bf`) for both authenticated
   and anonymous connections, Origin validation (`303a435`) rejecting a
   forged Origin.
2. **Formula engine.** All functions (`SUM`/`AVG`/`MIN`/`MAX`/`COUNT`/
   `COUNTA`/`ROUND`/`ABS`/`IF`/`CONCAT`), `$` locking, blank-cell arithmetic
   (`=A1+5` with blank `A1` → 5, not `NaN`, per the `arithNumber` fix),
   copy/paste reference shifting (re-verify the clipboard-race fix,
   `fbd7377` — copy/paste multiple times in a row, rapid succession, to
   stress the timing this bug came from), structural insert/delete
   reference shifting, `ACTIONGROUP`-aware reference shifting on structural
   delete (only the dead action drops, not the whole button — `1cc4f4b`),
   circular references (`#ERROR`, no hang), dependency recalculation across
   local edits AND remote WS patches.
3. **`ACTIONGROUP`/`USERINFO`.** The consolidated one-dialog prompt (not
   per-field native prompts), any field name works (not just name/email),
   `name` is decoupled from account identity (seeded once, freely editable
   after), `saveOnEdit` defaults `true`, clearing a watched cell deletes its
   cookie including `name`, same-batch clear (button + target together)
   skips the cookie delete, `hideOnClick` auto-resets when all tracked cells
   go empty.
4. **Real-time collab & presence.** Multi-client sync, debounced persistence
   timing (5s/15s), presence roster/colors/active-idle, selection broadcast,
   tab-bar presence dots.
5. **Spreadsheet/tab structural ops.** Create/rename/reorder/delete tabs
   (owner-only), position-collision fix (atomic shift, no more shared
   positions), negative-position validation (422 not 500), CSV import
   preserving/growing `cols`/`rows`, spreadsheet duplicate (with/without
   sharing copy, custom title vs. auto-generated), title search/filter
   (`?title_contains=`), find-and-replace API (all scope forms: single cell,
   range, whole column, whole row, specific tabs vs. all tabs, case
   sensitivity, formula-cell replacement).
6. **Grid UI.** Insert/delete row/col, merge/unmerge, resize, arrow-key
   traversal INCLUDING the cursor-position-aware left/right-while-editing
   behavior, vertical scroll (mouse wheel, the `flex-shrink` fix), font/size
   dropdown (no duplicate "Effective size" entries, mixed-selection
   handling, the expanded font list), every dialog's click-outside-to-close
   (except the required name prompt, which must NOT close that way), the
   custom rename-tab dialog (not the native `window.prompt`), copyable text
   inside dialogs (the `_isModalOpen`/`_hasExternalTextSelection` fix — real
   text selection inside a modal must not be hijacked by the grid's
   document-level Ctrl+C handler).
7. **Deployment/hardening regression check.** `install.sh` dry run doesn't
   threaten `.mysql.env`/`.app.env` (the `P` protect filter), `.htaccess`
   blocks everything it should, `blanket-ws`'s own `.htaccess` deny-all,
   systemd unit matches the repo, WS server still bound to `127.0.0.1` only.

**Pass:** every scenario above behaves as documented in `CELL_SCHEMA.md`/
commit messages; any deviation goes in `BUGS_FOUND.md`.

---

## Section B — Mobile regression + feature-parity audit

**Part 1 — regression.** The 8 mobile bugs found and fixed this session
(touch drag-select for cells and row/col headers, topbar title collapse,
Share dialog overflow, sheets-list overflow, Manage Tabs arrow size, the
`.btn-small` mobile-height decision, formula-help mobile hint, and the
Share-dialog-input-over-shrink follow-up) were already re-tested once and
confirmed fixed. Re-confirm they're STILL fixed as part of this final gate
(cheap insurance, not redundant — this is the release gate, not a routine
check), same technique as before (`browser-testing-workaround` memory, real
Chromium + mobile viewport/touch emulation via `puppeteer-core`).

**Part 2 — feature parity (genuinely new, hasn't been done as its own
dimension).** Systematically go through every feature in Section A and
confirm it's actually usable via touch on a mobile viewport, not just
"doesn't crash." For each: can a mobile user actually complete the workflow
with touch alone? Specifically check:
- Every dialog (Share, Manage Tabs, History, Rename, Formula Help, the
  `USERINFO` consolidated prompt, the required name prompt) — already mostly
  covered by the mobile-dialogs testing, re-confirm functional completion
  (not just layout) via touch: can you actually grant/revoke access, rename a
  tab, restore a history version, submit the `USERINFO` prompt, all via tap?
- Context menus (cell right-click menu, row/column header menu) — these are
  desktop-mouse-oriented (`contextmenu` event); does mobile have any
  equivalent (long-press?), or is this functionality simply unreachable on
  mobile? If unreachable, this is a real parity gap — record it, don't just
  note "not tested."
- `ACTIONGROUP` buttons, `USERINFO` cookie-fill flow, `saveOnEdit` clearing
  behavior — full touch-driven round trip.
- CSV import/export — is the file-picker (`<input type=file>`) usable on
  mobile (it should be, standard mobile file-picker UI, but confirm).
- Duplicate spreadsheet / "Make a copy" buttons, search/filter (if there's
  any UI for `title_contains`, or is it API-only — if API-only, note that
  explicitly, it's not a mobile gap, it's a desktop gap too).
- Presence viewer list / active-idle dots — visible and legible on a mobile
  viewport width.
- Formula bar — editing via the formula bar (not just in-cell) on mobile,
  including the two bugs from Section G once fixed.

**Part 3 — the WebKit/Safari gap (read this, it's a hard constraint, not
optional to skip).** Every mobile test this session — this plan included —
uses real Chromium with Blink's mobile emulation. **No mobile testing so far
has used a WebKit-based engine**, which is what actual iPhone/iOS users run
(Android Chrome IS Blink, so Android coverage is more representative;
iOS Safari is not, on any browser, since Apple mandates WebKit for all iOS
browsers).

Investigated as part of writing this plan: `npx playwright install webkit`
(no `--with-deps`, so no root needed) DOES download a real WebKit binary
(`~/.cache/ms-playwright/webkit-2311`, GTK and WPE variants) without any
permission prompt. However, actually running it hits a dependency chain an
order of magnitude larger than Chromium's: `ldd` on the wrapper binary
falsely reports nothing missing (it's checking the wrong binary — the real
payload is `minibrowser-gtk/bin/MiniBrowser`), and running that directly
fails on `libgstreamer-1.0.so.0` first, with Playwright's own installer
validator listing ~20 more behind it: GTK4 and its own large dependency tree
(pango, cairo, gdk-pixbuf, etc. — not enumerated by Playwright's flat list,
would need to be discovered incrementally), a dozen individual GStreamer
plugin packages, `libgraphene`, `libepoxy`, `libmanette`, `libenchant`,
`libhyphen`, `libsecret`, `libatk`/`libatk-bridge`, `libwoff2dec`. Spot-checked
that the top-level packages ARE in `apt`'s index (`libgtk-4-1`,
`libgstreamer1.0-0`, etc.) so the `apt-get download` + `dpkg-deb -x`
technique isn't structurally blocked — but `apt-get download` doesn't resolve
transitive dependencies the way `apt-get install` does, so getting this
fully working means manually discovering and downloading every transitive
dependency of GTK4 and GStreamer too, likely 20-40+ additional packages
beyond the ~20 already identified, with no guarantee some obscure transitive
dependency isn't itself hard to satisfy this way.

**Recommendation:** attempt this as a genuinely time-boxed, best-effort
sub-task (an hour or two of an agent's time, not open-ended) — if it comes
together, running the existing mobile test suite against real WebKitGTK
would catch real engine-specific JS/CSS incompatibilities Blink wouldn't
surface, which has real value. **But do not treat it as blocking**, and even
if WebKitGTK is gotten running, it is still a Linux desktop WebKit build,
not Apple's actual iOS WebKit configuration (different touch/viewport
synthesis, no real iOS keyboard, different default fonts/rendering). **Real
device verification by Fernando himself, on an actual iPhone, is a mandatory
manual gate before client release regardless of what any headless testing
finds** — this project's own history (the entire mobile bug batch) already
demonstrates that touch-specific behavior needs real touch input to catch
reliably; a real device is the only way to be genuinely confident about iOS
Safari specifically. Say this to Fernando plainly when reporting results,
don't let a clean WebKitGTK pass (if achieved) read as "iOS verified."

---

## Section C — Security

Re-verify what's already been built, then probe for anything new:

**Re-verify (regression):**
- JWT hello-based auth (`e2c26bf`) and Origin validation (`303a435`) both
  still correctly reject forged/invalid credentials.
- The full permission matrix (owner/edit/view/anonymous), especially the
  permissive anon-fallback change (`0431c71`) — confirm it did NOT
  accidentally loosen `canManage()` (tab-structure ops must stay strictly
  owner/admin-only).
- JWT expiry/tampering/forging (alg=none, signature tampering, expired-but-
  validly-signed) — re-run given the TTL is now 6 months, not 12h; a forged
  expired token is a much more attractive target now than when this was
  last tested (a stale-but-valid token has 6 months of exploitability
  instead of 12 hours) — this raises the real-world stakes of this check
  even though the mechanism itself hasn't changed.

**New probing (hasn't been done from this specific angle):**
- **XSS / unsanitized rendering.** Does ANY cell value, formula text,
  spreadsheet title, tab name, `USERINFO` field value/name, or display name
  ever get inserted into the DOM as raw HTML rather than as text content?
  Try titles/cell values containing `<script>`/`<img onerror=...>`/similar
  in every user-controllable text field across the app (spreadsheet title,
  tab name, cell value, display name, `USERINFO` `infoType` string, Share
  dialog username input) and confirm it renders as literal text everywhere,
  never executes.
- **SQL injection.** The app uses PDO prepared statements throughout by
  established convention — spot-check anyway on every endpoint that takes a
  free-form string (search/filter `title_contains`, find-and-replace
  `find`/`replace`, `USERINFO` field names, usernames) with injection-shaped
  payloads (`' OR '1'='1`, etc.), confirm no behavioral difference from a
  benign string of the same shape.
- **IDOR / access-control edge cases.** Can an authenticated user read or
  write a spreadsheet/tab by guessing/incrementing an ID or GUID they were
  never granted access to and have no anonymous-policy fallback for? Try
  sequential IDs, try a real GUID with characters altered.
- **CSRF.** JWTs live in `localStorage` (not a cookie), which already blocks
  ambient-credential CSRF — confirm there's genuinely no cookie-based auth
  path anywhere (a forgotten fallback, a legacy code path) that would
  reintroduce this.
- **Mobile-specific.** Does token storage/handling differ meaningfully on a
  mobile browser (e.g. any mobile-Safari-specific `localStorage` quirks in
  private/incognito mode, though this may only be testable for real on a
  device per the Section B WebKit gap)?

---

## Section D — Performance (genuinely untested ground — nothing here has
been checked at all this entire project)

- **Large spreadsheets.** Resize a tab well beyond the 6×20 default (try
  200+ rows, 50+ columns) and confirm: grid rendering stays responsive,
  scroll stays smooth, formula recalculation (especially a deep dependency
  chain, 50-100+ cells long) doesn't visibly stall the UI, copy/paste across
  a large range completes in reasonable time.
- **Many concurrent WS connections on one tab.** Simulate 10, then 20+
  simultaneous WS clients on the same tab_id — measure edit-broadcast
  latency to other clients, confirm the debounced-persistence mechanism
  (5s/15s) still behaves correctly under sustained concurrent editing (no
  dropped saves, no duplicate/out-of-order history rows), confirm presence
  roster broadcasts don't degrade badly at this scale (each presence
  broadcast is the FULL roster, not a diff — check whether this becomes a
  real bottleneck at 20+ viewers).
- **Database query performance at realistic scale.** Insert a meaningfully
  large `spreadsheet_history` table (thousands of rows across many tabs) and
  a meaningful number of spreadsheets for one user, then measure
  `GET /api/spreadsheets` (with and without `title_contains`) and
  `GET /api/tabs/{id}/current` (fetching "current state" from history)
  response times — confirm existing indexes are adequate, no full-table
  scans on the hot paths.
- **Client-side memory over a long session.** Leave a tab open performing
  repeated operations (edits, undo-equivalent clears, tab switches) over an
  extended synthetic session and watch for unbounded memory growth (check
  `_buildActionGroupWatches()`/`_buildDependents()`, which are rebuilt fresh
  on every relevant call by design — confirm this doesn't itself become a
  performance problem at a large cell count, since it's an O(cells) scan
  each time).
- **Mobile device performance.** Rendering/scrolling a large sheet (same
  large-spreadsheet scenario above) under mobile viewport + touch emulation
  — mobile devices are real-world slower than this server's Chromium: note
  this is still not a perfect proxy for a real phone's CPU/GPU, flag as an
  approximation, not a guarantee.

**Pass:** no operation exhibits pathological (non-linear, unbounded) scaling
that would degrade real client usage at plausible real-world scale (a church
spreadsheet is unlikely to be enormous, but a release gate should still
confirm there's no cliff at a size a real user could plausibly reach).

---

## Section E — WebSocket collaboration matrix

This needs deliberate coverage of collaborator COUNT and PLATFORM MIX, not
just "does WS work" (already covered in Section A):

- **Web ↔ Web:** 2 collaborators (baseline, already covered elsewhere), then
  **3, then 5+** collaborators simultaneously editing the SAME tab — verify
  no lost updates (every collaborator's edit is visible to every other),
  correct RFC 7396 merge-patch behavior when two collaborators edit
  DIFFERENT cells simultaneously vs. the SAME cell simultaneously (last-
  write-wins is the documented model — confirm it actually behaves that way,
  not something worse like corrupting the document), presence roster
  accuracy and distinct colors at each count (the palette is 12 colors —
  explicitly test what happens at 13+ simultaneous viewers, does it wrap/
  collide/crash?).
- **Web ↔ Mobile:** one web (desktop Chromium) + one mobile-emulated client,
  both editing the same tab — cross-platform edit visibility, presence
  correctness, no platform-specific message-format assumption breaking the
  other side.
- **Mobile ↔ Mobile:** two+ mobile-emulated clients on the same tab.
- **Mixed 3+:** a genuine mix (e.g. 2 web + 2 mobile) on the same tab
  simultaneously — this is the real-world scenario most likely to actually
  happen (a family/committee editing together from different devices) and
  hasn't been tested in this combination at all.
- **Race conditions specifically:** rapid-fire simultaneous edits to the SAME
  cell from 3+ clients in quick succession — confirm the final state is
  coherent (not corrupted/partial), and that `saveOnEdit`/`ACTIONGROUP`
  cookie-sync behavior (local-only by design, `applyRemote` never triggers
  it) holds correctly even under this kind of concurrent load.
- **Disconnect/reconnect churn** with many viewers present — one client
  drops mid-session, others' rosters update correctly, no stale entries
  linger.

---

## Section F — Anything else relevant, beyond Fernando's explicit list

Flagging these as scope additions, with why:

- **Data integrity of the append-only history model at scale/under
  concurrency** — already partially covered by Section D/E, but worth its
  own explicit check: after heavy concurrent multi-client editing, does
  `spreadsheet_history`'s sequence numbering stay strictly monotonic and
  gapless per tab, with no duplicate/skipped sequences? This is the
  foundation the whole undo/history/restore feature relies on.
- **Error handling / graceful degradation** — what does a real user actually
  see if the WS connection drops mid-edit (does the app fall back to the
  REST autosave path correctly, per the documented `localSaveFallbackTimer`
  design, or does it silently lose edits)? What happens on a genuinely
  malformed/corrupted cell value already in the database (pre-existing bad
  data, not something the app itself would write) — does rendering degrade
  gracefully or crash the whole tab?
- **Basic accessibility sanity** — not full WCAG audit, but: can the app be
  used at all via keyboard alone on desktop (already partially covered by
  arrow-key traversal), are focus states visible, is there any obvious
  screen-reader-hostile pattern (e.g. critical actions with no accessible
  name) worth a quick note even if not a blocking release item.

---

## Section G — Fix the two known pre-existing bugs (from `TODO.md`)

Unlike every other section, **actually root-cause and fix these**, don't
just re-confirm and re-log them:

1. **Formula-bar's cell-reference label goes stale after a drag-select.**
   Reproduces via plain mouse, nothing to do with the mobile touch work.
   Find where the formula bar's reference label is updated and why a
   drag-select doesn't trigger that update path.
2. **Enter in the formula bar commits the value, then the same keydown
   re-opens the cell for inline editing.** An event-ordering/blur-timing
   quirk in `_onKeyDown` — likely the commit-on-blur and the Enter-key
   handler are both firing from the same keystroke without one properly
   suppressing the other.

Fix, verify (real browser), deploy, commit, push to `origin master` — same
process as every other fix this session.

---

## Bug tracking

Every finding from Sections A-F goes in `/home/claude/blanket/BUGS_FOUND.md`
using its existing template. Section G's two bugs get fixed directly and
noted as resolved (not entered as new findings).

## Suggested sequencing

Run as separate `Workflow` invocations, roughly in this order (adjust if a
later section's findings change priority):

1. **Section G first** (quick, fixes 2 known bugs, low risk, clears the
   backlog before the big sweep).
2. **Section A** (full functional regression) — establishes whether core
   functionality is solid before spending effort on mobile/security/
   performance layered on top of it.
3. **Section B** (mobile regression + parity + the WebKit time-boxed
   attempt) — can run in parallel with Section C if resourced separately.
4. **Section C** (security).
5. **Section D** (performance) — likely the most novel/uncertain in scope,
   budget real time for it.
6. **Section E** (WS collaboration matrix) — benefits from A/B/C already
   being solid, since it's testing interaction effects, not fresh ground.

After all sections report in: synthesize `BUGS_FOUND.md` into a triage
summary for Fernando (by severity), and separately flag that Section B's
WebKit gap means a real-iPhone manual check from him is still needed
regardless of what automated testing shows, before the MySQL grant
narrowing and release.
