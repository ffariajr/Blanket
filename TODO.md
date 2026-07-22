# TODO

Deferred work — not urgent, tracked here so it isn't lost.

- **Login rate-limiting.** No throttling on the login endpoint currently. Noted as a gap in security-concerns.md; revisit later.
- **Move `/var/www/blanket-ws` to inside `/var/www/church`.** Done on the filesystem/repo side: content moved to `/var/www/church/blanket-ws` (locked down with `Require all denied` in its own `.htaccess`, created before any file landed there — see security-concerns.md #2b), and `deploy/blanket-ws.service`/`deploy/README.md`/`security-concerns.md` updated to the new path. **Still needs fvf, root-only:** install the updated unit and restart the service —
  ```
  sudo cp /home/claude/blanket/deploy/blanket-ws.service /etc/systemd/system/blanket-ws.service
  sudo systemctl daemon-reload
  sudo systemctl restart blanket-ws
  ```
