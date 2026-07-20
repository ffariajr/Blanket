"""Blanket real-time collaboration WebSocket server.

Wire protocol (JSON text frames):

Connect to: ws://host:port/ws/tabs/{tab_id}?token=<JWT>  (token optional)

Client -> server, first message MUST be "hello":
  {"type": "hello", "name": "Display name"}
    `name` is REQUIRED for anonymous connections (no/invalid token) --
    it's what the frontend collects via its "what's your name?" prompt and
    stores in a cookie, per the earlier design. Ignored for authenticated
    connections (display name comes from the JWT).

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

Persistence: throttled (see session.py), always a full-document snapshot
into spreadsheet_history -- never the edit patches themselves.
"""

import asyncio
import json
import logging
import signal
import sys
from urllib.parse import urlparse, parse_qs

from websockets.asyncio.server import serve
from websockets.exceptions import ConnectionClosed

import access
import auth
from session import TabSession, ClientInfo

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("blanket.server")

HOST = "127.0.0.1"
PORT = 8765


def parse_request(path):
    """Returns (tab_id:int|None, token:str|None)."""
    parsed = urlparse(path)
    parts = [p for p in parsed.path.split("/") if p]
    if len(parts) != 3 or parts[0] != "ws" or parts[1] != "tabs":
        return None, None
    try:
        tab_id = int(parts[2])
    except ValueError:
        return None, None
    query = parse_qs(parsed.query)
    token = query.get("token", [None])[0]
    return tab_id, token


def client_ip(websocket):
    addr = websocket.remote_address
    return addr[0] if addr else "0.0.0.0"


async def handle_connection(websocket):
    request_path = websocket.request.path
    tab_id, token = parse_request(request_path)
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

    identity = auth.resolve_identity(token, hello.get("name"))
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
    except ConnectionClosed:
        pass
    finally:
        await session.remove_client(websocket)
        logger.info("client left tab_id=%s user_id=%s", tab_id, identity.user_id)


async def main():
    stop = asyncio.Event()

    def _handle_signal():
        logger.info("shutdown signal received, flushing sessions")
        stop.set()

    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, _handle_signal)

    async with serve(handle_connection, HOST, PORT):
        logger.info("listening on ws://%s:%s/ws/tabs/{tab_id}", HOST, PORT)
        await stop.wait()

    await TabSession.flush_all()
    logger.info("all sessions flushed, exiting")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        sys.exit(0)
