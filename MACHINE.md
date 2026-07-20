# Machine Environment

Notes on the host this project (and future projects run by Claude Code as the
`claude` user) live on. Project-agnostic — update this file, not just
`README.md`, when the environment changes.

## Identity / access

- Host: `dogmanjr.net`, multiple IPs on one box (63.141.229.170/171/172).
  Debian 13 (trixie), kernel 6.12.
- Claude Code runs as `claude` (uid 1018), groups `claude, users, sshusers`.
  Not in `www-data`, no sudo. Deliberately restricted — the human admin is
  `fvf` (uid 1001); `root` does system administration.
- `ccsudo` (`/home/claude/ccsudo/`, not yet installed) would let `claude` run
  read-only `ls`/`cat` as root against any path except a denylist of secrets
  (shadow, SSH/TLS private keys). Not installed system-wide — apache configs
  happen to be world-readable so it hasn't been needed yet.
- 62 GiB RAM, 125 GiB free disk.

## Web stack (shared across projects)

- Apache 2.4.67, `apache2.service`, listening only on 80/443/22 externally.
- PHP 8.4.23 via `libapache2-mod-php`. Broad set of extensions preinstalled:
  mysqli/PDO-mysql, curl, gd, mbstring, bcmath, Slim's PSR-7, Symfony
  cache/config components, php-nikic-fast-route, recaptcha, PHPMyAdmin's SQL
  parser lib. `php-composer-ca-bundle` is present but the `composer` binary
  itself is not on PATH.
- Enabled modules: mod_proxy, mod_proxy_http, mod_wsgi, mod_rewrite,
  mod_ssl. **mod_proxy_wstunnel is installed but not enabled** — needed to
  reverse-proxy WebSocket upgrades through Apache.
- Existing deployment pattern to copy: `api.dogmanjr.net` is a Flask app
  bound to `127.0.0.1:5000`; Apache does `ProxyPass`/`ProxyPassReverse` to
  it and terminates TLS (Let's Encrypt certs under
  `/etc/letsencrypt/live/<host>/`). Any standalone Python service should
  follow this shape: bind localhost-only, let Apache be the sole
  externally-facing listener and TLS terminator.
- Deployment paths under `/var/www/*` are `www-data`-owned, not writable by
  `claude`. Deploys are done by `fvf`/root, not directly by Claude Code.

## Database

- No MySQL/MariaDB *server* on this box — only the client (`mysql`,
  `mysqldump`, MySQL 8.4 client) and the `phpmyadmin` package. The database
  server lives on a separate host, `db.dogmanjr.net` (173.208.153.82).
- Connectivity confirmed: DNS resolves, ICMP works, and TCP 3306 to
  `db.dogmanjr.net` is reachable from this box. App↔DB traffic is not
  blocked outbound. No credentials or `~/.my.cnf` exist yet on this box.

## Python

- Python 3.13.5, `venv` module available.
- System-wide (`/usr/lib/python3/dist-packages`, installed via apt) already
  includes: `websockets` 15.0.1, `Flask` 3.1.1, `gunicorn`, `bcrypt`,
  `cryptography`, `aiohttp`, `APScheduler`, and more. **PyJWT is not
  installed.**
- These packages live in system dist-packages (apt-managed), not
  `pip --user` — new packages likely need root to add system-wide. Use a
  project-local venv instead; that's fully within `claude`'s own write
  access and is the right pattern regardless.

## Node

- v24.18.0 / npm 11, installed user-locally at `~/.local`. Fine for any
  build tooling; not required by the current stack.

## Security posture

- `firewalld`, `fail2ban`, and `clamav` all run as active services.
- `claude` cannot inspect or modify firewalld rules (`firewall-cmd` needs
  privilege not granted here). Given the existing api.dogmanjr.net pattern
  (bind to `127.0.0.1`, Apache proxies), new firewalld rules likely aren't
  needed for typical services.

## General pattern for this box

One Apache instance in front of everything. PHP runs in-process via
mod_php. Any Python service runs as a standalone process on localhost with
Apache reverse-proxying it and owning TLS. Deploys and system config
changes are done by `fvf`/root, not by `claude`.
