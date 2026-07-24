"""Spreadsheet-wide viewer presence: who's currently connected across every
tab of a spreadsheet, what cell(s) they've selected, and whether they're
active or idle right now.

Separate from TabSession (session.py), which is scoped per tab_id and owns
the actual document/persistence -- presence is a thin layer on top, scoped
per spreadsheet_id instead, since a viewer on tab A needs to know about a
viewer on tab B of the same spreadsheet (Fernando: "if that user is viewing
another tab, they should still appear"). No locking needed on the registry
dicts below: every mutation here happens synchronously with no `await`
between a check and the corresponding write, so nothing can interleave
mid-operation on asyncio's single-threaded event loop (same reasoning
TabSession's own dict already relies on for its lock-free paths). The
broadcast() *network fan-out* is a separate concern from the dict
mutations and IS guarded by a lock (see `_broadcast_lock`), since multiple
in-flight `await ws.send(...)` calls from separate broadcast() invocations
could otherwise interleave and deliver an earlier, now-stale snapshot to a
client after a later, correct one.
"""

import asyncio
import itertools
import json
import logging
import time

logger = logging.getLogger("blanket.presence")

# 12 visually-distinct colors. Scoped per spreadsheet (not global) -- two
# different spreadsheets can reuse the same color for different people,
# only viewers of the SAME spreadsheet need distinct colors from each
# other. Degrades to cycling/reuse if more concurrent viewers than colors
# ever occur (see _assign_color) -- not worth more effort than that at
# this app's scale (a handful of concurrent editors).
#
# Same color renders both a viewer's name in the presence list and their
# remote-cell-selection highlight (assets/js/app.js) directly against the
# app's light background (--color-bg #f7f8fa / --color-surface #ffffff,
# see assets/css/app.css) with no contrast/luminance adjustment -- so
# every entry here has to be legible on its own, not just "visually
# distinct" from its neighbors. The original list (a well-known 20-color
# categorical palette) was picked purely for hue distinctness and included
# several colors (#46f0f0 cyan, #bcf60c lime, #f58231 orange, #3cb44b
# green, #f032e6 magenta, #008080 teal, and #e6194b red on the slightly
# darker --color-bg) that fall well short of WCAG AA's 4.5:1 minimum for
# normal text -- see BUGS_FOUND.md [034]. Each failing entry below has been
# darkened (same hue/saturation, lower lightness) just enough to clear
# 4.5:1 against #f7f8fa (the harder of the two backgrounds, with a small
# safety margin for rounding) -- entries that already passed are
# untouched, so some legitimate hue/lightness variety remains; this is not
# meant to make all 12 look identical.
_PALETTE = [
    "#df1849", "#2b8236", "#4363d8", "#bc5309", "#911eb4", "#0a7f7f",
    "#cb0fc1", "#5e7c05", "#007f7f", "#9a6324", "#800000", "#000075",
]

_connection_ids = itertools.count(1)


class Viewer:
    def __init__(self, connection_id, tab_id, user_id, name, is_anonymous, color):
        self.connection_id = connection_id
        self.tab_id = tab_id
        self.user_id = user_id
        self.name = name
        self.is_anonymous = is_anonymous
        self.color = color
        self.selection = None
        self.active = True
        # Updated only when `active` actually transitions (not on every
        # message) -- "last active" means "last time they were confirmed
        # active", not "last time we heard from them at all".
        self.last_active_at = time.time()

    def to_dict(self):
        return {
            "connection_id": self.connection_id,
            "user_id": self.user_id,
            "name": self.name,
            "is_anonymous": self.is_anonymous,
            "color": self.color,
            "tab_id": self.tab_id,
            "selection": self.selection,
            "active": self.active,
            "last_active_at": self.last_active_at,
        }


class SpreadsheetPresence:
    _registries = {}  # spreadsheet_id -> SpreadsheetPresence

    def __init__(self, spreadsheet_id):
        self.spreadsheet_id = spreadsheet_id
        self.viewers = {}  # websocket -> Viewer
        # Serializes broadcast() calls against each other (only the send
        # fan-out below, not the registry mutations above, which stay
        # synchronous/lock-free per the module docstring). Without this,
        # two broadcast() invocations triggered by near-simultaneous events
        # (e.g. two viewers disconnecting at nearly the same instant) could
        # have their `await ws.send(...)` calls interleave, letting an
        # earlier (now-stale) roster snapshot finish delivering to a client
        # AFTER a later, correct one -- leaving that client stuck on a
        # stale roster with no self-correction.
        self._broadcast_lock = asyncio.Lock()

    @classmethod
    def get_or_create(cls, spreadsheet_id):
        registry = cls._registries.get(spreadsheet_id)
        if registry is None:
            registry = cls(spreadsheet_id)
            cls._registries[spreadsheet_id] = registry
            logger.info("presence registry opened spreadsheet_id=%s", spreadsheet_id)
        return registry

    def _assign_color(self):
        used = {v.color for v in self.viewers.values()}
        for color in _PALETTE:
            if color not in used:
                return color
        return _PALETTE[len(self.viewers) % len(_PALETTE)]

    async def add_viewer(self, ws, tab_id, user_id, name, is_anonymous):
        connection_id = next(_connection_ids)
        viewer = Viewer(connection_id, tab_id, user_id, name, is_anonymous, self._assign_color())
        self.viewers[ws] = viewer
        await self.broadcast()
        return viewer

    async def remove_viewer(self, ws):
        if ws not in self.viewers:
            return
        del self.viewers[ws]
        if not self.viewers:
            if self.__class__._registries.get(self.spreadsheet_id) is self:
                del self.__class__._registries[self.spreadsheet_id]
                logger.info("presence registry closed spreadsheet_id=%s", self.spreadsheet_id)
            return
        await self.broadcast()

    def is_active(self, ws):
        """Cross-referenced by session.py's TabSession to find whether one
        of ITS clients is currently idle (see the [022] editor-congestion
        mitigation) -- ws is the same websocket object shared between this
        registry and TabSession.clients. Treats an unregistered ws (not
        yet added, or already removed) as active, i.e. never a candidate
        for the idle-demotion swap -- there's no idle *signal* to trust
        either way, and defaulting to "not idle" is the conservative
        choice (never wrongly evicts someone we actually know nothing
        about)."""
        viewer = self.viewers.get(ws)
        return viewer.active if viewer is not None else True

    async def set_active(self, ws, active):
        viewer = self.viewers.get(ws)
        if viewer is None or viewer.active == active:
            return
        viewer.active = active
        # Only stamp `last_active_at` on the activating (False->True)
        # transition -- it means "last time this viewer was confirmed
        # active", per the Viewer class comment above. Re-stamping it on
        # the deactivating transition too would give the client's
        # IDLE_GRACE_MS grace-period fallback (viewerIsActive() in app.js)
        # a fresh "now" to count from right as the viewer goes idle,
        # doubling real-world idle-detection latency for other viewers.
        if active:
            viewer.last_active_at = time.time()
        await self.broadcast()

    async def set_selection(self, ws, selection):
        viewer = self.viewers.get(ws)
        if viewer is None:
            return
        viewer.selection = selection
        await self.broadcast()

    async def broadcast(self):
        # Hold the lock across both the snapshot and the send fan-out so
        # concurrent broadcast() calls can never have their sends
        # interleave -- each broadcast fully delivers (in the order it was
        # invoked) before the next one's snapshot is even taken.
        async with self._broadcast_lock:
            message = json.dumps({
                "type": "presence",
                "viewers": [v.to_dict() for v in self.viewers.values()],
            })
            for ws in list(self.viewers.keys()):
                try:
                    await ws.send(message)
                except Exception:
                    logger.exception("presence broadcast failed, dropping viewer")
