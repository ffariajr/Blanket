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

---

## Start here — orientation for a fresh reader

**Assume you (and every subagent you dispatch) have never seen this project
before this moment.** This plan is written to be self-sufficient: everything
you need to actually execute it is either inlined below or in a project doc
this section points you to directly. Don't assume a dispatched subagent will
automatically have read the project's saved memories
(`/home/claude/.claude/projects/-home-claude-blanket/memory/`) before acting —
the load-bearing content from both memory files that exist there
(`browser-testing-workaround.md`, `concurrent_test_data_collisions.md`) is
reproduced verbatim-in-substance inside the Ground Rules section below so
nothing depends on a subagent independently pulling that in.

**What Blanket actually is, in one paragraph:** a self-hosted, mobile-friendly
spreadsheet web app, built for a church (live at
`https://church.dogmanjr.net/blanket/`), as a lightweight alternative to
Google Sheets for people who don't want to install an app or sign into a
Google account. Anonymous access is possible per-spreadsheet at the owner's
discretion (view-only or view+edit); authenticated accounts (admin-created
only, no self-registration) own/manage spreadsheets and can grant other users
access. Real-time collaborative editing is the headline feature. Every save
is a new row in an append-only history table — nothing is ever overwritten or
deleted except by an admin, and "current state" is always just the latest
row.

**How the pieces fit together:** a PHP REST API (Apache + mod_php,
`/var/www/church/blanket` on this box) handles auth, spreadsheet/tab CRUD,
sharing, and reads/writes the MySQL database (`blanket` schema, hosted on a
*separate* machine, `db.dogmanjr.net` — not local to this box). A Python
WebSocket server (`ws-server/`, deployed to `/var/www/church/blanket-ws`, run
by systemd as service `blanket-ws`, bound to `127.0.0.1:8765` only, reached
through an Apache reverse-proxy path `/blanket/ws/`) handles real-time
collaboration: live edits, presence, debounced persistence back to the same
MySQL history table. The frontend is plain/vanilla JavaScript (no framework,
no build step — `assets/js/*.js`, ES modules loaded directly by the browser).
Auth is JWT (HS256), shared secret between the PHP side and the WS server,
carried in the WebSocket's first `hello` message (not the connect URL — see
Section A item 1, this was a real fix this session).

**Read these project docs, in this order, before doing anything else** (all
paths relative to `/home/claude/blanket`):
1. `README.md` — what the app does and its feature list, ~1 minute read.
2. `MACHINE.md`, `REQUIREMENTS.md`, `ACCESS.md` — the hosting environment
   (this Linux user's constraints, what needs root vs. doesn't, what access
   this session actually has).
3. `CELL_SCHEMA.md` — the canonical per-tab cell-data JSON shape (what a
   formula cell, a merged cell, an `ACTIONGROUP`/`USERINFO` cell actually
   look like on disk/wire — required reading before testing the formula
   engine or `ACTIONGROUP` in Section A).
4. `security-concerns.md` — the current security posture: what's already
   fixed, what's a deliberately-accepted risk (don't re-flag these — see
   Ground Rules below), what's still open.
5. `db/schemas.md` — the live MySQL schema (tables, columns, indexes) —
   needed for Section D's database-performance work especially.
6. `deploy/README.md` — exactly how to deploy a change to either the PHP app
   or the WS server, and the sharp edges that have bitten this project twice
   already (see Ground Rules → Deploy mechanics below for the load-bearing
   parts inlined directly).
7. `TODO.md` — current open items; Section G below fixes the two bugs
   already logged there.

---

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
  tabs/history/access — this is Fernando's real, live data, not a fixture.
  **Repeat this to every dispatched subagent explicitly, every time** — don't
  assume it's remembered from one dispatch to the next. Every agent creates
  its own throwaway users/spreadsheets and deletes them when done (see
  cleanup rule below).

- **Naming: collision-resistant, not a fill-in-the-blank template.** Two
  different classes of test-data collision have actually happened this
  project already:
  1. A broad `LIKE`-pattern cleanup (`DELETE ... WHERE username LIKE
     'wftest_sharedprefix_%'`) hit a *sibling* agent's still-in-use rows
     mid-run, because the pattern matched a shared root prefix instead of
     that agent's own specific rows.
  2. Multiple agents were given a fill-in-the-blank naming template and some
     completed it identically (or one used the literal un-filled template
     string) — a later agent's `INSERT` then hit a duplicate-key error, and
     instead of picking a different name, it looked up and silently
     *reused* the pre-existing row (which actually belonged to a different,
     still-running agent), then deleted it during its own "cleanup" —
     pulling it out from under the agent that actually owned it.

  **The fix for both, every single time throwaway test data is created:**
  generate your own unpredictable suffix yourself (e.g. run `openssl rand
  -hex 4` and use that in the username/title), never fill in a shared
  template the same predictable way a concurrently-running sibling agent
  might. If an `INSERT` of throwaway test data ever hits a duplicate-key/
  unique-constraint error, that is a hard signal to retry with a
  *different* name — never look up and adopt/reuse the existing row, not
  even read-only. A same-named row appearing during a concurrent test run
  is never "mine from an earlier step" — parallel test agents share no
  state with each other.

- **Cleanup: exact ID only, never `LIKE`, no exceptions** — not even for a
  pattern that looks like it should only match "my own" rows. Delete
  `spreadsheet_history` rows for your own tab IDs, then your own tabs, then
  `spreadsheet_access` rows for your own spreadsheet IDs, then your own
  spreadsheets, then your own users — all by exact numeric ID, verified
  (`SELECT ... WHERE id = <exact id>`) before and after.

- **Real browser, not jsdom, wherever the finding could plausibly be a
  rendering/layout/timing issue.** A cached Chromium binary already exists
  on this box at `/home/claude/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome`
  (and `chromium_headless_shell-1228`) but fails to launch with a
  dynamic-linker error for four missing shared libraries. Installing them
  system-wide needs root, which this session doesn't have — but
  `apt-get download <pkg>` (fetches the `.deb` file to the current
  directory only, does not install anything, needs no root) works fine.
  Exact commands, run once per session/environment (cache the extracted
  libs in a stable scratch dir and reuse):
  ```bash
  mkdir -p /tmp/chrome-libs && cd /tmp/chrome-libs
  apt-get download libatk1.0-0t64 libatk-bridge2.0-0t64 libxdamage1 libatspi2.0-0t64
  mkdir extracted
  for f in *.deb; do dpkg-deb -x "$f" extracted; done
  export LD_LIBRARY_PATH=/tmp/chrome-libs/extracted/usr/lib/x86_64-linux-gnu:$LD_LIBRARY_PATH
  /home/claude/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome --version
  ```
  This launches a genuinely working Chrome — confirmed via real page
  navigation, real computed `scrollHeight`/`clientHeight`, real dispatched
  wheel/touch events, and (via `puppeteer-core`, installable locally with
  `npm install puppeteer-core` — no root, and unlike the full `puppeteer`
  package it does NOT try to download its own Chromium) real clipboard
  read/write with genuine async timing. Point `puppeteer-core` at it like
  this:
  ```js
  const puppeteer = require('puppeteer-core');
  const browser = await puppeteer.launch({
    executablePath: '/home/claude/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome',
    headless: true,
    args: ['--no-sandbox', '--disable-gpu'],
    env: { ...process.env, LD_LIBRARY_PATH: '/tmp/chrome-libs/extracted/usr/lib/x86_64-linux-gnu' },
  });
  ```
  **Do NOT use the `mcp__*__browser_*` / Playwright MCP tools for this** —
  they spawn their own Chrome process with its own fixed environment, and
  setting `LD_LIBRARY_PATH` in a Bash tool call does not propagate to that
  separate process, so those tools fail with the same missing-library error
  no matter what. Drive Chrome directly via Bash/CDP/`puppeteer-core`
  instead. jsdom is fine (and simpler) for pure-logic checks with no real
  layout/timing/clipboard involved (formula evaluation, dependency-graph
  correctness) — reserve real Chrome for anything that could plausibly be a
  rendering, layout, or timing-sensitive finding.

- **Every finding recorded in `BUGS_FOUND.md`** using the template already in
  that file — severity, area, precise reproduction, whether it was
  adversarially re-verified by a second agent. Concretely: whoever finds a
  bug writes it up; a genuinely *different* agent (not the same one, not
  told the first agent's conclusion, just given the reproduction steps)
  attempts to independently reproduce it from scratch; only mark
  `Verified: yes` once that second agent confirms it. If the second agent
  can't reproduce it, log it anyway as `Verified: no — see detail` rather
  than silently discarding it — Fernando should see it either way.

- **This app has changed substantially since the last full functional
  sweep** — formula copy/paste clipboard race fix, `ACTIONGROUP`
  reference-deletion handling, cookie-clearing-on-clear behavior, arrow-key
  cell traversal, vertical scroll fix, WS auth moved to the `hello` message,
  Origin validation, and the entire mobile bug batch (touch drag-select,
  topbar layout, Share dialog, sheets-list overflow, Manage Tabs button
  size). Don't assume anything not explicitly listed as "already
  re-verified" is still correct — a full regression sweep is warranted, not
  spot-checks.

- **Already known and deliberately accepted — do NOT re-flag as findings:**
  no login rate-limiting (Fernando explicitly considered and declined this —
  weighed a small MySQL table against PHP's System V shared-memory
  primitives, decided against both); the `blanket` MySQL user currently has
  `ALL PRIVILEGES` (already tracked in `TODO.md`, scheduled to be narrowed as
  the literal next step after this testing passes — this is expected, not a
  gap to discover and report).

- **Deploy mechanics — exact commands, needed to verify any fix you make:**
  - **PHP app** (frontend JS/CSS, `src/` PHP code): from `/home/claude/blanket`,
    run `./install.sh --apply`. This syncs an allowlisted set of paths
    (`.htaccess`, `index.html`, `index.php`, `assets/`, `src/`, `vendor/`) to
    `/var/www/church/blanket` and stamps a cache-busting version into
    `index.html`/`app.js`/`grid.js`/`ws.js`'s own `?v=` query strings. It
    does NOT touch `ws-server/`, `db/`, `deploy/`, or dotfile secrets
    (`.mysql.env`/`.app.env`, protected by an explicit rsync `P` filter rule
    after those were once accidentally deleted from production by an
    earlier, less careful version of this same script — see
    `security-concerns.md` #7).
  - **WS server** (`ws-server/*.py`): sync manually —
    ```bash
    rsync -a --no-owner --no-group --exclude venv/ --exclude __pycache__/ \
      /home/claude/blanket/ws-server/ /var/www/church/blanket-ws/ws-server/
    chgrp -R www-data /var/www/church/blanket-ws/ws-server
    ```
    **The `--no-owner --no-group` flags and the `chgrp -R www-data` afterward
    are load-bearing, not optional** — a plain `rsync -a` preserves the
    *source's* group (`claude`) instead of letting the destination inherit
    `www-data` from its setgid parent, which has broken the running
    `blanket-ws` systemd service (`User=www-data`) TWICE already with the
    exact same `CHDIR` crash-loop, since `www-data` ends up with zero access
    to a `claude`-group directory. If you change any `ws-server/*.py` file
    and skip these flags, expect the service to crash-loop — check
    `stat -c '%U:%G %a' /var/www/church/blanket-ws/ws-server` first if that
    happens.
  - **Critically: after any `ws-server/` change, the running `blanket-ws`
    systemd service will NOT pick it up until it's restarted, and this
    session has no `systemctl` access at all.** `sudo systemctl restart
    blanket-ws` has to be run by Fernando himself. State this plainly
    whenever a WS-server-side fix is made and awaiting deployment — don't
    assume it's live just because the files were synced to disk.

- **Git identity and push conventions.** No global `git config` is set for
  this user, so every commit needs identity passed explicitly:
  ```bash
  git -c user.email=claude.ai@fernandofaria.email -c user.name=Claude commit -m "..."
  ```
  Always a **new commit**, never `--amend`. A real GitHub remote exists —
  `git@github.com:ffariajr/Blanket.git` — and pushing to it (`git push
  origin master`) is normal, expected practice for this project, not
  something to hesitate over or ask permission for each time. Check
  `git status` before committing and stage only your own changes if
  anything else is unexpectedly present in the working tree (this has
  happened before when multiple agents touch the repo around the same
  time).

---

## Section A — Full functional regression sweep (web/desktop)

*Reminder: throwaway test data only, your own random-suffix naming, exact-ID
cleanup, never spreadsheet id=13 — see Ground Rules above.*

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

*Reminder: throwaway test data only, your own random-suffix naming, exact-ID
cleanup, never spreadsheet id=13 — see Ground Rules above.*

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
optional to skip).** **TL;DR for a skimming reader: real WebKit was already
investigated directly and found infeasible on this box (missing shared-lib
count an order of magnitude beyond Chromium's, with unresolved transitive
dependencies) — don't re-attempt it expecting a different result, spend the
time on the time-boxed attempt described below instead, and tell Fernando a
real-iPhone check is a mandatory manual gate regardless of outcome.** Full
detail: every mobile test this session — this plan included —
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

*Reminder: throwaway test data only, your own random-suffix naming, exact-ID
cleanup, never spreadsheet id=13 — see Ground Rules above.*

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

*Reminder: throwaway test data only, your own random-suffix naming, exact-ID
cleanup, never spreadsheet id=13 — see Ground Rules above.*

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

*Reminder: throwaway test data only, your own random-suffix naming, exact-ID
cleanup, never spreadsheet id=13 — see Ground Rules above.*

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

*Reminder: throwaway test data only, your own random-suffix naming, exact-ID
cleanup, never spreadsheet id=13 — see Ground Rules above.*

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

*Reminder: throwaway test data only for verification, your own random-suffix
naming, exact-ID cleanup, never spreadsheet id=13. Use the exact deploy
commands and git identity/push conventions from Ground Rules above.*

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
