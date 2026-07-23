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

**Already done, at `/var/www/church/blanket-ws`** (originally deployed to
the sibling path `/var/www/blanket-ws`, then moved inside `church/` at
Fernando's request):

```
mkdir /var/www/church/blanket-ws
rsync -a --no-owner --no-group --exclude venv/ --exclude __pycache__/ /home/claude/blanket/ws-server/ /var/www/church/blanket-ws/ws-server/
chgrp -R www-data /var/www/church/blanket-ws/ws-server
cp /home/claude/blanket/.mysql.env /home/claude/blanket/.app.env /var/www/church/blanket-ws/
chmod 640 /var/www/church/blanket-ws/.mysql.env /var/www/church/blanket-ws/.app.env
python3 -m venv /var/www/church/blanket-ws/ws-server/venv
/var/www/church/blanket-ws/ws-server/venv/bin/pip install -r /var/www/church/blanket-ws/ws-server/requirements.txt
```

**Critical, non-optional step:** `/var/www/church/blanket-ws/.htaccess`
must contain `Require all denied`. This directory sits *inside*
`DocumentRoot /var/www/church` (a sibling of `blanket/`), unlike the
original `/var/www/blanket-ws` location, which was structurally
unreachable by Apache regardless of any config. Now its non-exposure
depends entirely on that `.htaccess` being present and correct -- it was
created *before* any file was moved into the directory, specifically to
avoid a window where the secrets/source were reachable. If this
directory is ever recreated from scratch, create the `.htaccess` first.

Verified: server boots cleanly from this location (`server.py` run
directly), listens on `127.0.0.1:8765`, resolves `.mysql.env`/`.app.env`
correctly, and the venv's `bin/python` still resolves its interpreter and
imports correctly after the move (it symlinks to `/usr/bin/python3`,
not a path baked in under the venv itself, so relocating the whole venv
as one unit doesn't break it).

Currently owned `claude:www-data`, secrets at `640` (group-readable by
`www-data`, not world). Fernando's plan is to `chown -R www-data:www-data
/var/www` once development settles, which is why ownership wasn't
otherwise fussed over here -- once that happens, `640` on the two secrets
files still means only `www-data` (the new owner, and its own group) can
read them.

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
add `'token': '<JWT>'` to the hello payload from a real login (the token
travels in hello, not the connect URL -- see `ws-server/server.py`'s
docstring).

## Notes

- `install.sh` excludes `db/` and `deploy/` from the PHP deploy sync
  (dev-only tooling, no runtime purpose in the docroot) in addition to the
  existing git/docs/secrets/tests exclusions -- see its comments.
- **`--no-owner --no-group` (plus a `chgrp -R www-data` after) are load-bearing, not optional.** A plain `rsync -a` preserves the *source's* group (`claude`) instead of letting the destination inherit `www-data` from its setgid parent -- this has broken the running `blanket-ws` systemd service (which runs as `User=www-data`) twice now with the exact same `CHDIR` crash-loop, since `www-data` ends up with zero access to a `claude`-group, `750`-mode `ws-server/` directory. If a future deploy skips these flags and the service starts crash-looping right after, this is almost certainly why -- check `stat -c '%U:%G %a' /var/www/church/blanket-ws/ws-server` before looking anywhere else.
- If `blanket-ws` needs redeploying after a code change: re-run the rsync
  above (target `/var/www/church/blanket-ws/ws-server/`), then
  `sudo systemctl restart blanket-ws`. No auto-deploy yet, matching the
  PHP app's manual `install.sh --apply` model.
- See `security-concerns.md` for hardening items worth addressing,
  several of which are cheapest to do now while `fvf` is already on the
  box for step 2.
