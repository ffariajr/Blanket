# Access Needed

See `MACHINE.md` for environment context and `REQUIREMENTS.md` for what
each item is for.

## Read

- `/var/www/api/app.wsgi`, `app.py`, `wsgi.py`, `__init__.py` — currently
  `Permission denied` (owned `fvf:www-data`, mode 660, `claude` is not in
  `www-data`). Useful as a reference for how the existing Python service is
  run/deployed on this box. Not strictly required — would save re-
  explaining the pattern if granted.
- `/etc/letsencrypt/live/` — currently denied. Only needed if Claude Code
  ends up writing/checking vhost TLS blocks directly; not needed if `fvf`
  handles vhost edits.

## Write

**Superseded:** this entire section (through "Not needed" below) describes
the original access request before `/var/www` was `chown -R
claude:www-data`'d and `install.sh --apply` was built. `claude` can now
write `/var/www/church/blanket/` and `/var/www/church/blanket-ws/`
directly — see `deploy/README.md` for the actual deploy commands in use.
The items below are kept for history; treat anything not called out as
still-root-only (Apache vhost edits, systemd unit changes, `systemctl`
itself) as accurate, and everything else as outdated.

Expect most of this to be denied per your note — flagging what deployment
normally touches so you know what to do by hand:

- `/var/www/church/blanket/` — to place PHP files. Currently
  `www-data`-owned, unwritable by `claude`.
- `/etc/apache2/sites-available/050-church*.conf`, plus running
  `a2enmod proxy_wstunnel` and `systemctl reload apache2` — for the
  WebSocket proxy config.
- A systemd unit file under `/etc/systemd/system/` for the WebSocket
  server process, plus permission to enable/start it.
- Ability to create a MySQL database/user on `db.dogmanjr.net` — or have
  `fvf` provision it and hand Claude Code a connection string.

## Not needed

- Root shell, sudo, or `www-data` group membership in general. All
  development stays inside `/home/claude/blanket`, which `claude` already
  fully controls. Preference is for `fvf` to handle `/var/www`, Apache
  config, systemd, and DB provisioning by hand (or paste the exact
  commands run) rather than granting broad write access to shared system
  paths.
