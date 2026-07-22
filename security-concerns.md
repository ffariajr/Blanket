# Security and hardening concerns

Written while deploying the WebSocket server (`deploy/README.md`). Split
by who needs to act and how urgent it is. Nothing here is a known active
exploit against this app -- these are hardening gaps, called out honestly
rather than left silent.

## Already handled well (no action needed)

- **WS server binds `127.0.0.1` only** (`ws-server/server.py`) -- never
  directly reachable from outside, only through Apache's TLS-terminated
  proxy. Confirmed via `ss -tlnp` during deployment.
- **The `blanket` MySQL user is DML-only** (`SELECT/INSERT/UPDATE/DELETE`,
  no `CREATE/ALTER/DROP/GRANT`) -- both the PHP app and the WS server use
  the same scoped-down credential, never anything with DDL rights.
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

**2. `www-data` shared between the PHP app and the WS server.** Both
services run as the same user, so a compromise of either has the same
blast radius as compromising both -- a bug in one could read the other's
secrets or interfere with its process. A dedicated, unprivileged service
account for the WS server (instead of reusing `www-data`) would meaningfully
narrow this, at the cost of a bit more setup (new user, group read access
to `/var/www/church/blanket-ws/.mysql.env`/`.app.env`). Recommended, not
mandatory -- flagging the tradeoff rather than deciding it.

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

**4. Secrets file permissions on the PHP side.** `/var/www/church/blanket/.mysql.env`
and `.app.env` are currently **world-readable** (`chmod 644`) -- a
workaround from when I couldn't get `www-data` group read access any
other way (I'm not a member of that group and can't `chgrp` to it).
Once you do the planned `chown -R www-data:www-data /var/www`, these
should be tightened back down to `600` (owner-read-only) -- ownership
alone will make them unreadable to anyone but `www-data` at that mode,
same as the WS server's copies already are.

**5. No `Origin` header validation on the WS handshake.** Normally a
real cross-site-WebSocket-hijacking concern, but point 3 above (JWT in
localStorage, not a cookie) already blocks the main exploit path for
*authenticated* sessions. The remaining exposure is limited to
spreadsheets that already have anonymous view/edit access turned on --
which are already reachable the same way by anyone who just visits the
link, Origin check or not. Reasonable to add as defense-in-depth, low
priority given the actual exposure is small.

**6. No rate-limiting on `POST /api/login`.** Unrelated to the WS
work specifically, but adjacent enough to mention while on the topic:
nothing currently throttles repeated login attempts against a given
username. `fail2ban` is already running on this box (per `MACHINE.md`)
-- worth checking whether it's configured to watch this endpoint's
failure pattern in the Apache/PHP logs, or adding a rule if not.

## Not a concern, but worth knowing

- Firewalld only exposes 22/80/443 externally on this box -- there's no
  new port to open for the WS server, since it's proxied entirely through
  Apache's existing 443. Confirm this stays true (no rule accidentally
  exposes 8765) if anyone touches firewall config later.
