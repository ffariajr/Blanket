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

# [022] mitigation (BUGS_FOUND.md): edit-broadcast fanout cost within a
# TabSession scales with its number of ACTIVE simultaneous editors, so
# capping that at a small constant bounds it at O(MAX_ACTIVE_EDITORS x
# total_viewers) instead of O(total_viewers^2) in the worst case where
# every viewer also holds edit access. This is a genuine mitigation, not a
# fix for the underlying full-roster-rebroadcast design -- see this
# module's and presence.py's docstrings for that. The tab owner is always
# exempt (never counts against this cap, never demoted) per Fernando's
# spec; a plain view-only user was never a candidate for an edit slot in
# the first place.
MAX_ACTIVE_EDITORS = 6

CONGESTION_MESSAGE = (
    "Too many people are editing this sheet right now (limit 6) -- you "
    "can view live changes, and will be able to edit again once someone "
    "leaves or goes idle."
)


def pack_ip(ip_str):
    """4 bytes for IPv4, 16 for IPv6 -- matches INET6_ATON()'s output,
    read back with INET6_NTOA() on the PHP/SQL side."""
    try:
        return socket.inet_pton(socket.AF_INET, ip_str)
    except OSError:
        return socket.inet_pton(socket.AF_INET6, ip_str)


class ClientInfo:
    def __init__(self, identity, access_level, ip, is_owner=False):
        self.identity = identity
        self.access_level = access_level
        self.ip = ip
        self.is_owner = is_owner
        # [022] mitigation: session-level-only edit downgrade, layered on
        # top of access_level rather than replacing it -- this NEVER
        # touches the user's actual DB-granted access_level/permission
        # row, only whether THIS live WS connection is currently allowed
        # to send edits. Only ever True for a non-owner client whose
        # access_level is already "edit"; see TabSession._admit_editor.
        self.congestion_view_only = False


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
        # SpreadsheetPresence for this tab's spreadsheet -- set on the
        # first add_client (server.py resolves spreadsheet_id/creates the
        # registry before calling us). Needed for the [022] mitigation's
        # idle-swap check: presence.py is the existing idle-detection
        # mechanism (Viewer.active), cross-referenced by websocket to see
        # which of THIS TabSession's clients is currently idle. Every
        # client of a given TabSession belongs to the same spreadsheet
        # (a tab_id has exactly one spreadsheet_id), so this is never
        # overwritten with a different registry mid-session.
        self.presence = None
        # FIFO queue of websockets currently congestion-view-only, in the
        # order they were demoted -- "longest-waiting" (index 0) is who
        # gets promoted first when a slot frees up (see
        # _promote_next_waiting). A ws can appear here at most once at a
        # time; removed on promotion or disconnect.
        self._congestion_queue = []

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

    async def add_client(self, ws, client_info, presence):
        self.presence = presence
        # _admit_editor (the capacity check + its commit) and adding this
        # client to self.clients must happen back-to-back with no `await`
        # in between -- otherwise a concurrently-arriving connection's own
        # admission check can run (asyncio is cooperative, so it can only
        # interleave at an `await`) before this client is actually counted,
        # letting both arrivals see the same "one slot free" state and both
        # get admitted, overshooting MAX_ACTIVE_EDITORS. See _admit_editor's
        # docstring. Only the *notification* sends below (which don't
        # change any accounting) happen after -- the slot bookkeeping is
        # already fully committed by then.
        demoted_ws = self._admit_editor(ws, client_info)
        self.clients[ws] = client_info
        await ws.send(json.dumps({
            "type": "state",
            "sequence": self.sequence,
            "data": self.data,
        }))
        if demoted_ws is not None:
            await self._send_congestion_demote(demoted_ws)
        if client_info.congestion_view_only:
            await self._send_congestion_demote(ws)

    async def remove_client(self, ws):
        client = self.clients.pop(ws, None)
        was_active_editor = (
            client is not None
            and client.access_level == "edit"
            and not client.is_owner
            and not client.congestion_view_only
        )
        if ws in self._congestion_queue:
            self._congestion_queue.remove(ws)
        if not self.clients:
            # Last viewer gone -- don't leave a document parked only in
            # memory once nobody's watching it.
            await self._flush_if_dirty()
        elif was_active_editor:
            # [022] mitigation: this client held one of the 6 active-editor
            # slots -- freeing it up, so the longest-waiting congestion-
            # view-only editor (if any) gets promoted into it.
            await self._promote_next_waiting()
        await self._maybe_close()

    # --- [022] mitigation: active-editor cap -----------------------------
    #
    # A non-owner client with access_level "edit" is either an active
    # editor (congestion_view_only False, one of up to MAX_ACTIVE_EDITORS
    # slots) or congestion-view-only (session-level-only demotion, queued
    # for promotion). The owner is never touched by any of this. A plain
    # view-only client is likewise never touched -- it was never a
    # candidate for an edit slot.

    def _active_editor_count(self):
        return sum(
            1 for c in self.clients.values()
            if c.access_level == "edit" and not c.is_owner and not c.congestion_view_only
        )

    def _find_idle_active_editor(self):
        """A currently-active-editor's ws that presence.py reports idle
        right now, or None if every active editor is active (or presence
        isn't wired up yet, which shouldn't happen post-first-client)."""
        if self.presence is None:
            return None
        for ws, c in self.clients.items():
            if c.access_level == "edit" and not c.is_owner and not c.congestion_view_only:
                if not self.presence.is_active(ws):
                    return ws
        return None

    def _admit_editor(self, ws, client_info):
        """Called once, at connect time, for a newly-arriving client
        (not yet in self.clients -- ws is only used here to queue it if
        it ends up congestion-view-only, never to look it up in
        self.clients/presence). Owner and view-only clients are never
        touched -- congestion_view_only stays False (its constructor
        default) for them unconditionally.

        Deliberately a plain (non-async) function: the capacity check
        (_active_editor_count/_find_idle_active_editor) and its commit
        (setting congestion_view_only / appending to _congestion_queue)
        must happen as one uninterrupted synchronous stretch. asyncio is
        single-threaded and cooperative, so code with no `await` between
        a check and its matching mutation can never be interleaved by a
        concurrently-handled connection (same reasoning presence.py's
        module docstring relies on for its own lock-free dict mutations).
        Any `await self.something.send(...)` here would hand control back
        to the event loop mid-decision, letting a second simultaneous
        arrival's admission check run against a half-updated
        self.clients/queue and also get admitted -- overshooting
        MAX_ACTIVE_EDITORS (this genuinely happened pre-fix: see
        BUGS_FOUND.md).

        Returns the ws of an idle incumbent that was just demoted to make
        room for this new arrival (the caller sends its notification
        afterward, once all bookkeeping is committed), or None."""
        if client_info.is_owner or client_info.access_level != "edit":
            return None
        if self._active_editor_count() < MAX_ACTIVE_EDITORS:
            return None  # a slot is free -- stays an active editor
        idle_ws = self._find_idle_active_editor()
        if idle_ws is not None:
            # Bump the idle incumbent instead of the new arrival -- the
            # new connection takes the freed slot (congestion_view_only
            # stays False for it).
            self._demote_sync(idle_ws)
            return idle_ws
        # All 6 slots are full of ACTIVE (non-idle) editors -- the new
        # arrival goes view-only instead, joining the back of the
        # promotion queue like anyone else demoted this way.
        client_info.congestion_view_only = True
        self._congestion_queue.append(ws)
        return None

    def _demote_sync(self, ws):
        """The check+commit half of a demotion -- see _admit_editor's
        docstring for why this must stay synchronous (no await) and
        separate from the notification send. Returns True if ws was
        actually demoted (False if already gone/already view-only)."""
        client = self.clients.get(ws)
        if client is None or client.congestion_view_only:
            return False
        client.congestion_view_only = True
        self._congestion_queue.append(ws)
        return True

    async def _demote(self, ws, notify):
        if self._demote_sync(ws) and notify:
            await self._send_congestion_demote(ws)

    async def _promote_next_waiting(self):
        while self._congestion_queue:
            ws = self._congestion_queue.pop(0)
            client = self.clients.get(ws)
            if client is None or not client.congestion_view_only:
                # Disconnected (already pruned by remove_client, belt-and-
                # suspenders) or somehow already promoted -- skip.
                continue
            client.congestion_view_only = False
            await self._send_congestion_promote(ws)
            return

    async def handle_active_change(self, ws, active):
        """Called by server.py's presence_active handling, alongside
        presence.set_active() -- implements the "ongoing" rule: an active
        editor going idle only matters here if someone else is actually
        waiting in congestion-view-only. Becoming active again never
        forces anything (an idle-demoted user who becomes active again
        just stays view-only until a slot frees up some other way)."""
        if active:
            return
        client = self.clients.get(ws)
        if client is None or client.is_owner or client.access_level != "edit":
            return
        if client.congestion_view_only:
            return  # already view-only, nothing to swap
        if not self._congestion_queue:
            return  # nobody waiting -- an idle editor keeps its slot
        await self._demote(ws, notify=True)
        await self._promote_next_waiting()

    async def _send_congestion_demote(self, ws):
        try:
            await ws.send(json.dumps({"type": "congestion_demote", "message": CONGESTION_MESSAGE}))
        except Exception:
            logger.exception("congestion_demote send failed, dropping client")

    async def _send_congestion_promote(self, ws):
        try:
            await ws.send(json.dumps({"type": "congestion_promote"}))
        except Exception:
            logger.exception("congestion_promote send failed, dropping client")

    async def handle_new_edit(self, ws, payload):
        from merge_patch import apply_merge_patch

        client = self.clients[ws]
        if client.access_level != "edit" or client.congestion_view_only:
            await ws.send(json.dumps({"type": "error", "message": "View-only access"}))
            return

        self.data = apply_merge_patch(self.data, payload)
        self.dirty = True
        self.last_editor = client

        # Broadcast to EVERYONE, including the sender -- not
        # _broadcast_others(). An accepted edit here is now authoritative
        # (merged into self.data, the single source of truth this session
        # writes from), and on a same-cell race the sender's own optimistic
        # local render can already have been overwritten by an intervening
        # remote patch from another client's earlier (now-superseded) edit
        # by the time this one is accepted. Without echoing back to the
        # sender, nothing ever tells that client its own edit in fact won --
        # it's left permanently displaying that stale peer value instead of
        # its own now-authoritative one, with no self-correction (see
        # BUGS_FOUND.md [001]). grid.js's applyRemote() is idempotent
        # against a client re-receiving its own already-applied patch, so
        # this is safe for the common (non-racing) case too.
        await self._broadcast_all({
            "type": "new_edit",
            "from": self._sender_info(client),
            "payload": payload,
        })
        self._schedule_persist()

    async def handle_keystroke(self, ws, payload):
        client = self.clients[ws]
        if client.access_level != "edit" or client.congestion_view_only:
            # Ephemeral relay only, but still gated: a view-only client
            # (permission-based OR the [022] congestion-demoted kind)
            # broadcasting fake "typing" would be confusing/spoofable.
            return
        await self._broadcast_others(ws, {
            "type": "keystroke",
            "from": self._sender_info(client),
            "payload": payload,
        })

    async def handle_save(self, ws):
        client = self.clients[ws]
        if client.access_level != "edit" or client.congestion_view_only:
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
