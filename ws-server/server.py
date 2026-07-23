"""Blanket real-time collaboration WebSocket server.

Wire protocol (JSON text frames):

Connect to: ws://host:port/ws/tabs/{tab_id}

Client -> server, first message MUST be "hello":
  {"type": "hello", "name": "Display name", "token": "<JWT>"}
    `token` is optional -- omit it, or send an invalid/expired one, to
    connect as the anonymous sentinel user (id 0). Deliberately carried
    here instead of as a `?token=` query param on the connect URL (the
    latter is how this worked before) -- Apache's access log records the
    full request line for the initial HTTP upgrade, but never sees message
    frames exchanged after the WS connection is established, so a token
    that only ever travels in `hello` never ends up logged in plaintext
    (security-concerns.md #3). This doesn't change *when* identity gets
    resolved -- nothing privileged (session join, presence, document
    access) has ever been possible before `hello` arrives regardless of
    where the token travels, only *where the string sits on the wire*.
    `name` is REQUIRED when there's no valid token -- it's what the
    frontend collects via its "what's your name?" prompt and stores in a
    cookie, per the earlier design. Ignored for authenticated connections
    (display name comes from the JWT).

Client -> server, after hello:
  {"type": "keystroke", "payload": <anything>}
    Ephemeral relay only -- rebroadcast verbatim to other clients on this
    tab_id, never touches the document or the database. Rejected (silently
    dropped) from view-only clients.
  {"type": "new_edit", "payload": <JSON Merge Patch, RFC 7396>}
    Applied to the in-memory document immediately, then rebroadcast to
    other clients, independent of persistence timing. Rejected (with an
    "error" reply) from view-only clients.
  {"type": "save"}
    Forces an immediate persist if the document has unsaved changes.
  {"type": "presence_active", "active": true|false}
    Reports a page-visibility/idle-timer change. Rebroadcast (via a
    "presence" message, see below) to every connection across every tab
    of this spreadsheet, not just this tab_id -- presence is spreadsheet-
    wide (see presence.py).
  {"type": "selection", "selection": {"anchor": "A1", "selected": "B3"} | null}
    Reports the sender's current cell/range selection (anchor === selected
    for a single cell; null for nothing selected). Rebroadcast the same way.

Server -> client:
  {"type": "state", "sequence": N, "data": {...}}
    Sent once, right after hello: the tab's current full document.
  {"type": "new_edit", "from": {"user_id":.., "name":".."}, "payload": {...}}
    Another client's edit, relayed.
  {"type": "keystroke", "from": {...}, "payload": {...}}
    Another client's keystroke event, relayed.
  {"type": "saved", "sequence": N}
    A persist just happened; N is the new current sequence.
  {"type": "error", "message": "..."}
  {"type": "presence", "viewers": [{"connection_id":.., "user_id":..,
    "name":.., "is_anonymous":.., "color":"#rrggbb", "tab_id":..,
    "selection":{...}|null, "active":.., "last_active_at":<epoch seconds>}, ...]}
    Sent once right after hello (current roster) and again on every
    connect/disconnect/presence_active/selection anywhere in the
    spreadsheet -- the FULL roster every time, not a diff (church-scale
    concurrency, not worth incremental diffing). Includes viewers on
    OTHER tabs of the same spreadsheet, each tagged with their tab_id, so
    a client can show "someone's on a different tab" (e.g. a color dot on
    that tab in the tab bar) as well as who's on the tab it's actually
    looking at.

Persistence: throttled (see session.py), always a full-document snapshot
into spreadsheet_history -- never the edit patches themselves.
"""

import asyncio
import json
import logging
import signal
import sys
from urllib.parse import urlparse

from websockets.asyncio.server import serve
from websockets.exceptions import ConnectionClosed

import access
import auth
from session import TabSession, ClientInfo
from presence import SpreadsheetPresence

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("blanket.server")

HOST = "127.0.0.1"
PORT = 8765

# Cross-Site WebSocket Hijacking defense-in-depth (security-concerns.md #5).
# `None` is included per the websockets library's own recommendation for
# this: a real browser always sends Origin on a WS handshake, so a MISSING
# header can't be the browser-based hijack this guards against -- only a
# WRONG one can. Allowing None keeps non-browser clients (curl-less test
# scripts, this project's own diagnostic tooling) working unauthenticated-
# Origin-wise, same as before this change, while still rejecting any page
# on another origin trying to open a WS connection here on a victim's behalf.
ALLOWED_ORIGIN = "https://church.dogmanjr.net"


def parse_request(path):
    """Returns tab_id:int|None. The token used to also come from here (a
    ?token= query param) -- now carried in the hello message instead, see
    this module's docstring, so there's nothing left to parse but tab_id."""
    parsed = urlparse(path)
    parts = [p for p in parsed.path.split("/") if p]
    if len(parts) != 3 or parts[0] != "ws" or parts[1] != "tabs":
        return None
    try:
        return int(parts[2])
    except ValueError:
        return None


def client_ip(websocket):
    addr = websocket.remote_address
    return addr[0] if addr else "0.0.0.0"


async def handle_connection(websocket):
    request_path = websocket.request.path
    tab_id = parse_request(request_path)
    if tab_id is None:
        await websocket.close(code=1008, reason="Expected /ws/tabs/{tab_id}")
        return

    try:
        hello_raw = await asyncio.wait_for(websocket.recv(), timeout=10)
        hello = json.loads(hello_raw)
    except (asyncio.TimeoutError, json.JSONDecodeError, ConnectionClosed):
        await websocket.close(code=1008, reason="Expected hello message")
        return

    if hello.get("type") != "hello":
        await websocket.close(code=1008, reason="First message must be 'hello'")
        return

    identity = auth.resolve_identity(hello.get("token"), hello.get("name"))
    if identity.is_anonymous and not hello.get("name"):
        await websocket.close(code=1008, reason="Anonymous connections must supply a name")
        return

    try:
        spreadsheet_id, access_level = await asyncio.get_running_loop().run_in_executor(
            None, access.resolve, tab_id, identity.user_id, identity.is_admin
        )
    except access.AccessDenied as e:
        await websocket.close(code=1008, reason=str(e))
        return

    client_info = ClientInfo(identity, access_level, client_ip(websocket))
    session = await TabSession.get_or_create(tab_id)
    await session.add_client(websocket, client_info)
    presence = SpreadsheetPresence.get_or_create(spreadsheet_id)
    await presence.add_viewer(websocket, tab_id, identity.user_id, identity.display_name, identity.is_anonymous)
    logger.info(
        "client joined tab_id=%s user_id=%s name=%s access=%s",
        tab_id, identity.user_id, identity.display_name, access_level,
    )

    try:
        async for raw in websocket:
            try:
                message = json.loads(raw)
            except json.JSONDecodeError:
                continue

            msg_type = message.get("type")
            if msg_type == "new_edit":
                await session.handle_new_edit(websocket, message.get("payload", {}))
            elif msg_type == "keystroke":
                await session.handle_keystroke(websocket, message.get("payload", {}))
            elif msg_type == "save":
                await session.handle_save(websocket)
            elif msg_type == "presence_active":
                await presence.set_active(websocket, bool(message.get("active")))
            elif msg_type == "selection":
                await presence.set_selection(websocket, message.get("selection"))
    except ConnectionClosed:
        pass
    finally:
        await session.remove_client(websocket)
        await presence.remove_viewer(websocket)
        logger.info("client left tab_id=%s user_id=%s", tab_id, identity.user_id)


async def main():
    stop = asyncio.Event()

    def _handle_signal():
        logger.info("shutdown signal received, flushing sessions")
        stop.set()

    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, _handle_signal)

    async with serve(handle_connection, HOST, PORT, origins=[ALLOWED_ORIGIN, None]):
        logger.info("listening on ws://%s:%s/ws/tabs/{tab_id}", HOST, PORT)
        await stop.wait()

    await TabSession.flush_all()
    logger.info("all sessions flushed, exiting")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        sys.exit(0)
