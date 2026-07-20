"""Per-tab_id authoritative document + persistence throttling.

One TabSession per open tab_id, created on first client connect, torn down
after the last client disconnects (which forces a final flush first). This
process is the single writer of a tab_id's spreadsheet_history rows while
a session is live -- that's what prevents concurrent-save races, not
database locking.

Persistence is throttled, not per-edit: a write happens at most once every
DEBOUNCE_SECONDS after the last edit (trailing debounce), but at least once
every MAX_WAIT_SECONDS even under continuous editing, immediately when the
last client disconnects, on an explicit "save" message, and (via
server.py's signal handler) on graceful shutdown.
"""

import asyncio
import json
import logging
import socket

import db

logger = logging.getLogger("blanket.session")

DEBOUNCE_SECONDS = 5
MAX_WAIT_SECONDS = 15


def pack_ip(ip_str):
    """4 bytes for IPv4, 16 for IPv6 -- matches INET6_ATON()'s output,
    read back with INET6_NTOA() on the PHP/SQL side."""
    try:
        return socket.inet_pton(socket.AF_INET, ip_str)
    except OSError:
        return socket.inet_pton(socket.AF_INET6, ip_str)


class ClientInfo:
    def __init__(self, identity, access_level, ip):
        self.identity = identity
        self.access_level = access_level
        self.ip = ip


class TabSession:
    _sessions = {}
    _sessions_lock = asyncio.Lock()

    def __init__(self, tab_id, sequence, data):
        self.tab_id = tab_id
        self.sequence = sequence
        self.data = data
        self.dirty = False
        self.clients = {}  # websocket -> ClientInfo
        self.last_editor = None  # ClientInfo of the most recent accepted new_edit
        self.persist_lock = asyncio.Lock()
        self.debounce_task = None
        self.max_wait_task = None

    @classmethod
    async def get_or_create(cls, tab_id):
        async with cls._sessions_lock:
            session = cls._sessions.get(tab_id)
            if session is not None:
                return session
            loop = asyncio.get_running_loop()
            sequence, data = await loop.run_in_executor(None, db.fetch_current_state, tab_id)
            session = cls(tab_id, sequence, data)
            cls._sessions[tab_id] = session
            logger.info("session opened tab_id=%s sequence=%s", tab_id, sequence)
            return session

    async def _maybe_close(self):
        async with self.__class__._sessions_lock:
            if not self.clients and self.__class__._sessions.get(self.tab_id) is self:
                del self.__class__._sessions[self.tab_id]
                logger.info("session closed tab_id=%s", self.tab_id)

    async def add_client(self, ws, client_info):
        self.clients[ws] = client_info
        await ws.send(json.dumps({
            "type": "state",
            "sequence": self.sequence,
            "data": self.data,
        }))

    async def remove_client(self, ws):
        self.clients.pop(ws, None)
        if not self.clients:
            # Last viewer gone -- don't leave a document parked only in
            # memory once nobody's watching it.
            await self._flush_if_dirty()
        await self._maybe_close()

    async def handle_new_edit(self, ws, payload):
        from merge_patch import apply_merge_patch

        client = self.clients[ws]
        if client.access_level != "edit":
            await ws.send(json.dumps({"type": "error", "message": "View-only access"}))
            return

        self.data = apply_merge_patch(self.data, payload)
        self.dirty = True
        self.last_editor = client

        await self._broadcast_others(ws, {
            "type": "new_edit",
            "from": self._sender_info(client),
            "payload": payload,
        })
        self._schedule_persist()

    async def handle_keystroke(self, ws, payload):
        client = self.clients[ws]
        if client.access_level != "edit":
            # Ephemeral relay only, but still gated: a view-only client
            # broadcasting fake "typing" would be confusing/spoofable.
            return
        await self._broadcast_others(ws, {
            "type": "keystroke",
            "from": self._sender_info(client),
            "payload": payload,
        })

    async def handle_save(self, ws):
        client = self.clients[ws]
        if client.access_level != "edit":
            await ws.send(json.dumps({"type": "error", "message": "View-only access"}))
            return
        await self._flush_if_dirty()

    async def _broadcast_others(self, sender_ws, message):
        encoded = json.dumps(message)
        for ws in list(self.clients.keys()):
            if ws is sender_ws:
                continue
            try:
                await ws.send(encoded)
            except Exception:
                logger.exception("broadcast failed, dropping client")

    @staticmethod
    def _sender_info(client):
        return {
            "user_id": client.identity.user_id,
            "name": client.identity.display_name,
        }

    def _schedule_persist(self):
        if self.debounce_task is not None:
            self.debounce_task.cancel()
        self.debounce_task = asyncio.create_task(self._after_delay(DEBOUNCE_SECONDS))

        if self.max_wait_task is None:
            self.max_wait_task = asyncio.create_task(self._after_delay(MAX_WAIT_SECONDS))

    async def _after_delay(self, seconds):
        try:
            await asyncio.sleep(seconds)
        except asyncio.CancelledError:
            return
        await self._flush_if_dirty()

    async def _flush_if_dirty(self):
        async with self.persist_lock:
            if not self.dirty:
                return

            # Cancel the OTHER pending timer, never the one currently
            # executing this code -- self.debounce_task/self.max_wait_task
            # may *be* the task that's awaiting this very coroutine (when
            # a timer fires and calls _flush_if_dirty itself). Cancelling
            # a task from within its own call stack throws CancelledError
            # into it at the next await -- i.e. right here, aborting the
            # persist before it runs -- which silently dropped every
            # timer-triggered save in testing; only the disconnect/explicit
            # -save paths (called from a different task) ever completed.
            current = asyncio.current_task()
            if self.debounce_task is not None and self.debounce_task is not current:
                self.debounce_task.cancel()
            self.debounce_task = None
            if self.max_wait_task is not None and self.max_wait_task is not current:
                self.max_wait_task.cancel()
            self.max_wait_task = None

            editor = self.last_editor
            next_sequence = self.sequence + 1
            loop = asyncio.get_running_loop()
            await loop.run_in_executor(
                None,
                db.insert_history_row,
                self.tab_id,
                next_sequence,
                self.data,
                editor.identity.user_id,
                pack_ip(editor.ip),
                editor.identity.display_name,
            )
            self.sequence = next_sequence
            self.dirty = False
            logger.info(
                "persisted tab_id=%s sequence=%s saved_by=%s",
                self.tab_id, self.sequence, editor.identity.user_id,
            )

            await self._broadcast_all({"type": "saved", "sequence": self.sequence})

    async def _broadcast_all(self, message):
        encoded = json.dumps(message)
        for ws in list(self.clients.keys()):
            try:
                await ws.send(encoded)
            except Exception:
                logger.exception("broadcast failed, dropping client")

    @classmethod
    async def flush_all(cls):
        """Called on graceful shutdown (SIGTERM)."""
        for session in list(cls._sessions.values()):
            await session._flush_if_dirty()
