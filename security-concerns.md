# Security and hardening concerns

Written while deploying the WebSocket server (`deploy/README.md`). Split
by who needs to act and how urgent it is. Nothing here is a known active
exploit against this app -- these are hardening gaps, called out honestly
rather than left silent.

## Already handled well (no action needed)

- **WS server binds `127.0.0.1` only** (`ws-server/server.py`) -- never
  directly reachable from outside, only through Apache's TLS-terminated
  proxy. Confirmed via `ss -tlnp` during deployment.
- ~~**The `blanket` MySQL user is DML-only**~~ -- **incorrect, corrected
  below (#7).** `SHOW GRANTS` on the live credential returns
  `GRANT ALL PRIVILEGES ON blanket.* TO 'blanket'@'dogmanjr.net'`, not
  DML-only. This line was aspirational/wrong when written; left visible
  with a strikethrough rather than silently deleted, since the same
  mistake (assuming a hardening step happened because it was written down)
  is exactly what let install.sh delete live secrets -- see #7.
- **JWTs live in `localStorage`, not a cookie** -- a malicious third-party
  page can't get a victim's browser to silently attach it to a request
  the way ambient cookie auth would allow. Meaningfully reduces the CSRF/
  cross-site-WebSocket-hijack surface described below.
- **The DB connection requires TLS** (`REQUIRE SSL` on the MySQL grant,
  enforced in `src/Db.php` and `ws-server/db.py` via explicit SSL params
  -- both had to be fixed at least once during development because the
  respective driver doesn't negotiate TLS by default without it).

## Worth fixing now, while `fvf` is on the box for the WS wiring anyway

**1. Systemd sandboxing for `blanket-ws.service` -- done.** Added
directly to the unit file already (nothing left to do here):

```ini
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/var/www/church/blanket-ws
```

`ReadWritePaths` matters here specifically because nothing about the WS
server's *normal* operation needs to write outside its own directory --
it only talks to the database over the network and reads its own config
files. If the process is ever compromised (a bug in a dependency, a
malicious formula/cell payload triggering something unexpected), this
caps what it can touch on disk.

**2. `www-data` shared between the PHP app and the WS server -- considered,
declined.** Both services run as the same user, so a compromise of either
has the same blast radius as compromising both. A dedicated, unprivileged
service account for the WS server would narrow this, but Fernando decided
against it: `blanket-ws` is not a generic WebSocket server that some future
unrelated site on this box might reuse -- its message protocol, `tab_id`
routing, and auth model are all specific to Blanket, so a hypothetical
second site would need its own WS service regardless, with its own
dedicated account at that point. Not worth the setup cost for an isolation
boundary that would only ever separate Blanket from itself.

**2b. `blanket-ws` now lives inside `church/`'s docroot.** Originally
deployed to `/var/www/blanket-ws`, a sibling of `church/` under
`/var/www` -- structurally unreachable by Apache no matter what, since it
sat outside `DocumentRoot /var/www/church` entirely. Moved to
`/var/www/church/blanket-ws` at Fernando's request, which changes that:
it's now *inside* a `Require all granted` docroot, and its non-exposure
depends entirely on `/var/www/church/blanket-ws/.htaccess` containing
`Require all denied` (created before any file was moved in, so there was
never a window where it was reachable). If that `.htaccess` is ever lost,
edited, or the directory recreated without it, the WS server's source and
DB credentials become directly downloadable. Worth an occasional
`curl -I https://church.dogmanjr.net/blanket-ws/ws-server/server.py`
sanity check (expect 403) after any change near there.

**3. JWTs land in Apache's access logs.** The WS handshake carries the
token as a URL query parameter (`?token=<JWT>`) -- the only practical way
to authenticate a browser WebSocket connection, since browsers don't let
JS set custom headers on the WS upgrade request. Apache's `CustomLog`
directives on this vhost log full request URIs by default, so every
authenticated WS connection attempt writes a live bearer token (valid up
to 12h, `src/Auth/Jwt.php`'s TTL) into `church-access.log` in plaintext.
Log files are root-readable-only, so this isn't an open exposure, but
it's a real defense-in-depth gap -- worth either a custom `LogFormat`
that redacts the query string for `/blanket/ws/` specifically, or
confirming log retention/access is something you're deliberately fine
with.

## Worth tightening, lower urgency

**4. Secrets file permissions on the PHP side -- done.** Fernando ran
`chown -R claude:www-data /var/www`, and `install.sh` now explicitly
`chmod 640`s `.mysql.env`/`.app.env` after every deploy (previously its
blanket `chmod o+r` on all files was quietly widening them back to `644`
on every single deploy -- fixed at the same time as #7 below).

**5. No `Origin` header validation on the WS handshake -- done.**
`ws-server/server.py` now passes `origins=[ALLOWED_ORIGIN, None]`
(`ALLOWED_ORIGIN = "https://church.dogmanjr.net"`) to `serve()` -- the
`websockets` library's own built-in mechanism for this, not custom logic.
A connection with a present-but-wrong `Origin` is rejected with HTTP 403
before the WS upgrade completes. `None` (no `Origin` header at all) is
explicitly allowed, per the library's own documented rationale: a real
browser always sends `Origin` on a WS handshake, so a missing header
can't be the cross-site-hijack vector this guards against -- only a
wrong one can -- and allowing it keeps non-browser clients (this
project's own diagnostic scripts, `ws-server/test_client.py`, etc.)
working exactly as before. Verified against a scratch instance on a
different port: a forged `Origin` (`https://evil.example.com`) gets
HTTP 403 before ever reaching `handle_connection`; both a correct
`Origin` and a missing one complete a full hello/state/new_edit/persist
round-trip normally. Needs fvf to `rsync` + restart the `blanket-ws`
systemd service for this to take effect in production -- not live yet
as of this commit.

**6. No rate-limiting on `POST /api/login` -- considered, dropped.**
Fernando decided against adding app-level rate-limiting (weighed a small
MySQL table against PHP's System V shared-memory primitives; decided the
feature wasn't worth either). `fail2ban` is already running on this box
(per `MACHINE.md`) and may already cover login brute-forcing if it's
watching this endpoint's failure pattern in the Apache/PHP logs -- not
confirmed either way, and not being pursued further right now.

**7. `install.sh` briefly deleted the live `.mysql.env`/`.app.env` and
broke production.** When the deploy script was rewritten from a denylist
to an allowlist (to stop a different leak, see the "Allowlist, not a
denylist" comment in `install.sh`), `--delete-excluded` was added so past
leaks would clean themselves up automatically. `.mysql.env`/`.app.env`
were never meant to be *transferred* by this script (see `deploy/
README.md` -- they're hand-copied once), but they live in `$DEST_DIR` and
`src/Config.php` reads them off disk on every single request, not just at
deploy time. Being excluded from transfer and being deleted are different
things, and the script conflated them: an `--apply` run deleted both
files, and every API call started 500ing until they were manually
restored. Fixed with an explicit rsync `P` (protect) filter rule for both
paths, ahead of the allowlist, so they're excluded from transfer but
specifically exempted from `--delete-excluded`. Caught only by chance
while investigating an unrelated DB-grants question, not by any
monitoring -- worth keeping in mind that this app currently has no health
check or alerting of any kind; a mistake like this one is otherwise
silent until someone happens to look, or a user reports it.

**8. Login tokens now live for 6 months, with sliding renewal, by
deliberate choice.** Was 12h. Fernando: "I want the site to remember a
logged-in user indefinitely" -- explicitly chose sliding renewal (a
long-but-bounded TTL that quietly refreshes to a full new window on every
app boot, via `POST /api/session/renew`, `src/Auth/Jwt.php`'s
`TTL_SECONDS`) over the simpler alternative of just issuing one
very-long-lived token. The tradeoff that decision buys back: a token that
genuinely stops being used (lost device, browser never reopened) still
expires on its own eventually rather than being valid forever, and if
`JWT_SECRET` ever needs rotating for a real incident, that's still the
one lever that invalidates everything at once -- same properties as
before, just over a much longer practical window for someone who visits
occasionally. `AuthController::renew()` re-fetches the account by
username rather than trusting the token's own embedded claims, so a
renewal correctly fails once an account is disabled or deleted, even
though the token it's renewing from was still technically unexpired.

## Not a concern, but worth knowing

- Firewalld only exposes 22/80/443 externally on this box -- there's no
  new port to open for the WS server, since it's proxied entirely through
  Apache's existing 443. Confirm this stays true (no rule accidentally
  exposes 8765) if anyone touches firewall config later.
