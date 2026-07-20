# What Blanket Needs — Dev and Deploy

See `MACHINE.md` for the environment this is based on.

## Development (Claude Code can do this directly, in `/home/claude/blanket`)

- PHP app code (pages, API endpoints). Needed extensions (mysqli/PDO_mysql,
  mbstring, curl) are already present system-wide.
- A Python venv for the WebSocket server (`python3 -m venv`), with
  `websockets` (already available system-wide, but pin it in the venv) plus
  `PyJWT` and `bcrypt`/`cryptography` for auth — install into the venv,
  which is a local, unprivileged action.
- JWT signing on the PHP side: needs a JWT library (e.g.
  `firebase/php-jwt` via Composer) or a hand-rolled HS256 implementation,
  since `composer` isn't on PATH. Either request Composer be installed, or
  vendor a JWT library directly into the repo.
- Local schema / dev DB: MySQL isn't installed on this box, only the
  client. Need either:
  - credentials to a dev/staging database on `db.dogmanjr.net`, or
  - a local disposable MySQL/SQLite substitute for iteration before
    pushing schema to the real server.
  This needs a decision — see the "Data model" note in
  `/home/claude/.claude/CLAUDE.md`: database design decisions should go
  through the user before assuming an approach.

## Deployment (needs `fvf`/root — Claude Code cannot do this directly)

- Copy PHP app files into `/var/www/church/blanket/` (already exists,
  `www-data`-owned, empty).
- Enable `mod_proxy_wstunnel` (`a2enmod proxy_wstunnel` + reload) so Apache
  can proxy the WebSocket upgrade.
- Add a `ProxyPass`/`RewriteRule` block to `050-church.conf` /
  `050-church-le-ssl.conf` (or a new location block) routing e.g.
  `/blanket/ws` to `127.0.0.1:<port>`.
- A systemd unit (or equivalent) to keep the Python WebSocket server
  running/restarting — ideally mirroring however `api.dogmanjr.net`'s
  Flask process is run today. Claude Code couldn't read
  `/var/www/api/app.wsgi` / `app.py` (permission denied, `fvf:www-data`
  660) to confirm the exact pattern in use.
- MySQL database + user creation on `db.dogmanjr.net`, and a way to get
  credentials onto this box (env file / secrets, not committed to the
  repo).
- A JWT signing secret shared between PHP and the Python server,
  provisioned once and kept out of version control.
