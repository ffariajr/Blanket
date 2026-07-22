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
TabSession's own dict already relies on for its lock-free paths).
"""

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
_PALETTE = [
    "#e6194b", "#3cb44b", "#4363d8", "#f58231", "#911eb4", "#46f0f0",
    "#f032e6", "#bcf60c", "#008080", "#9a6324", "#800000", "#000075",
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

    async def set_active(self, ws, active):
        viewer = self.viewers.get(ws)
        if viewer is None or viewer.active == active:
            return
        viewer.active = active
        viewer.last_active_at = time.time()
        await self.broadcast()

    async def set_selection(self, ws, selection):
        viewer = self.viewers.get(ws)
        if viewer is None:
            return
        viewer.selection = selection
        await self.broadcast()

    async def broadcast(self):
        message = json.dumps({
            "type": "presence",
            "viewers": [v.to_dict() for v in self.viewers.values()],
        })
        for ws in list(self.viewers.keys()):
            try:
                await ws.send(message)
            except Exception:
                logger.exception("presence broadcast failed, dropping viewer")
