# Deploying Blanket

Two independent pieces: the PHP app (Apache-served, static+API) and the
Python WebSocket server (a standalone process, proxied by Apache).

## 1. PHP app — already deployed by Claude

```
cd /home/claude/blanket
./install.sh --apply
cp .mysql.env .app.env /var/www/church/blanket/
```

(`install.sh` deliberately never syncs `.mysql.env`/`.app.env` -- copied
by hand into the deploy root, sibling to `index.php` -- `src/Config.php`
resolves them via `dirname(__DIR__)`, i.e. the app root.)

Live at `https://church.dogmanjr.net/blanket/`.

## 2. WebSocket server — code deployed by Claude, wiring needs root/fvf

**Already done, at `/var/www/blanket-ws`:**

```
mkdir /var/www/blanket-ws
rsync -a --exclude venv/ --exclude __pycache__/ /home/claude/blanket/ws-server/ /var/www/blanket-ws/ws-server/
cp /home/claude/blanket/.mysql.env /home/claude/blanket/.app.env /var/www/blanket-ws/
chmod 600 /var/www/blanket-ws/.mysql.env /var/www/blanket-ws/.app.env
python3 -m venv /var/www/blanket-ws/ws-server/venv
/var/www/blanket-ws/ws-server/venv/bin/pip install -r /var/www/blanket-ws/ws-server/requirements.txt
```

Verified: server boots cleanly from this location (`server.py` run
directly), listens on `127.0.0.1:8765`, resolves `.mysql.env`/`.app.env`
correctly, and shuts down gracefully on SIGTERM. Not left running --
there's no supervisor for it yet (that's step 2b).

Currently owned `claude:www-data`, secrets at `600` (owner-read-only).
Fernando's plan is to `chown -R www-data:www-data /var/www` once
development settles, which is why ownership wasn't otherwise fussed over
here -- once that happens, `600` on the two secrets files means only
`www-data` (the new owner) can read them, which is *more* restrictive
than the workaround needed on the PHP side (see security-concerns.md).

**Still needs root/fvf** — nothing below this point is about file
ownership under `/var/www`; these are genuine root-only operations
(kernel module loading, `/etc/apache2`, `/etc/systemd/system`, `systemctl`):

**a. Enable WebSocket proxying in Apache** — see
`deploy/apache-websocket-proxy.conf` for the exact snippet and where it
goes in `050-church.conf` / `050-church-le-ssl.conf`.

```
sudo a2enmod proxy_wstunnel
# edit both vhost files, add the two ProxyPass/ProxyPassReverse lines
sudo apache2ctl configtest
sudo systemctl reload apache2
```

**b. Install and start the systemd service:**

```
sudo cp /home/claude/blanket/deploy/blanket-ws.service /etc/systemd/system/blanket-ws.service
sudo systemctl daemon-reload
sudo systemctl enable --now blanket-ws
```

Review `security-concerns.md` before this step -- a few cheap systemd
hardening directives are worth adding to `blanket-ws.service` first
(it already has a comment flagging this).

## 3. Verify

```
systemctl status blanket-ws          # should be active (running)
journalctl -u blanket-ws -n 50       # startup log, should show "listening on ws://127.0.0.1:8765/ws/tabs/{tab_id}"
```

End-to-end WebSocket smoke test (from any machine with `websockets`
installed, or reuse `ws-server/test_client.py` pointed at the public URL):

```
python3 -c "
import asyncio, websockets, json
async def main():
    async with websockets.connect('wss://church.dogmanjr.net/blanket/ws/tabs/1') as ws:
        await ws.send(json.dumps({'type': 'hello', 'name': 'smoke-test'}))
        print(await ws.recv())
asyncio.run(main())
"
```

A `{"type": "state", ...}` reply confirms the whole chain (Apache TLS ->
wstunnel proxy -> blanket-ws systemd service -> DB) is working. Use a
tab_id that actually exists and has anonymous view/edit access set, or
include `?token=<JWT>` from a real login.

## Notes

- `install.sh` excludes `db/` and `deploy/` from the PHP deploy sync
  (dev-only tooling, no runtime purpose in the docroot) in addition to the
  existing git/docs/secrets/tests exclusions -- see its comments.
- If `blanket-ws` needs redeploying after a code change: re-run the rsync
  above, then `sudo systemctl restart blanket-ws`. No auto-deploy yet,
  matching the PHP app's manual `install.sh --apply` model.
- See `security-concerns.md` for hardening items worth addressing,
  several of which are cheapest to do now while `fvf` is already on the
  box for step 2.
