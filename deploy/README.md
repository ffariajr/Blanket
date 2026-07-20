# Deploying Blanket

Two independent pieces: the PHP app (Apache-served, static+API) and the
Python WebSocket server (a standalone process, proxied by Apache). Each
step below is marked with who can actually do it.

## 1. PHP app — Claude (claude user) can do this alone

The `claude` user already has write access to `/var/www/church/blanket`
and DDL access to the `blanket` database (dev-time grants). No root/fvf
action needed for this part.

```
cd /home/claude/blanket
./install.sh --apply
cp .mysql.env .app.env /var/www/church/blanket/
```

(`install.sh` deliberately never syncs `.mysql.env`/`.app.env` -- copy them
by hand, once, into the deploy root, sibling to `index.php` --
`src/Config.php` resolves them via `dirname(__DIR__)`, i.e. the app root.)

Verify: `https://church.dogmanjr.net/blanket/api/health` should return
`{"status":"ok"}`. The frontend and REST API work at this point even
before the WebSocket server is wired up -- real-time collab just won't be
live yet (the frontend fork built it to degrade gracefully to plain
REST-based load/save when the socket isn't reachable).

## 2. WebSocket server -- needs root/fvf

Claude does not have write access outside `/var/www/church/blanket`, and
cannot touch `/etc/apache2`, `/etc/systemd/system`, or run
`systemctl`/`a2enmod`. Everything below this point needs a human with
sudo.

**a. Deploy the server code** (suggested path -- adjust freely, just keep
`deploy/blanket-ws.service` in sync with wherever it actually goes):

```
sudo mkdir -p /var/www/blanket-ws
sudo rsync -a --exclude venv/ --exclude __pycache__/ /home/claude/blanket/ws-server/ /var/www/blanket-ws/ws-server/
sudo cp /home/claude/blanket/.mysql.env /home/claude/blanket/.app.env /var/www/blanket-ws/
sudo chown -R www-data:www-data /var/www/blanket-ws
```

(`.mysql.env`/`.app.env` go at `/var/www/blanket-ws/`, one level *above*
`ws-server/` -- `ws-server/config.py` resolves them the same way
`src/Config.php` does, relative to its own parent directory.)

**b. Set up the venv:**

```
sudo -u www-data python3 -m venv /var/www/blanket-ws/ws-server/venv
sudo -u www-data /var/www/blanket-ws/ws-server/venv/bin/pip install -r /var/www/blanket-ws/ws-server/requirements.txt
```

**c. Enable WebSocket proxying in Apache** -- see
`deploy/apache-websocket-proxy.conf` for the exact snippet and where it
goes in `050-church.conf` / `050-church-le-ssl.conf`. Summary:

```
sudo a2enmod proxy_wstunnel
# edit both vhost files, add the two ProxyPass/ProxyPassReverse lines
sudo apache2ctl configtest
sudo systemctl reload apache2
```

**d. Install and start the systemd service:**

```
sudo cp /home/claude/blanket/deploy/blanket-ws.service /etc/systemd/system/blanket-ws.service
sudo systemctl daemon-reload
sudo systemctl enable --now blanket-ws
```

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

- `install.sh` now excludes `db/` and `deploy/` from the PHP deploy sync
  (dev-only tooling, no runtime purpose in the docroot) in addition to the
  existing git/docs/secrets/tests exclusions -- see its comments.
- If `blanket-ws` needs restarting after a code change:
  `sudo systemctl restart blanket-ws`. There's no auto-deploy for the WS
  server yet, matching the PHP app's manual `install.sh --apply` model --
  redeploy step 2a, then restart.
