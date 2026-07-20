"""Resolves a user's effective access level for a tab.

Not specified anywhere before now, so documenting the precedence rule
chosen here: owner or admin always get 'edit'. Otherwise the effective
level is the higher of (a) an explicit spreadsheet_access row for this
user_id and (b) the spreadsheet's anonymous policy row (user_id=0) -- i.e.
a logged-in user with no explicit grant still gets at least whatever the
public/anonymous policy allows, they don't need their own row to match a
baseline that's already public. No row at all (neither explicit nor
anonymous) on either side means no access.
"""

import db

_RANK = {None: 0, "view": 1, "edit": 2}


class AccessDenied(Exception):
    pass


def resolve(tab_id, user_id, is_admin):
    """Returns (spreadsheet_id, access_level) where access_level is
    'view' or 'edit'. Raises AccessDenied otherwise (no access, or the tab
    / spreadsheet doesn't exist or is deleted)."""
    tab = db.fetch_tab(tab_id)
    if tab is None or tab["deleted_at"] is not None:
        raise AccessDenied("Tab not found")

    spreadsheet = db.fetch_spreadsheet(tab["spreadsheet_id"])
    if spreadsheet is None or spreadsheet["deleted_at"] is not None:
        raise AccessDenied("Spreadsheet not found")

    if is_admin or (user_id != 0 and user_id == spreadsheet["owner_id"]):
        return spreadsheet["id"], "edit"

    explicit = db.fetch_access_level(spreadsheet["id"], user_id) if user_id != 0 else None
    anonymous = db.fetch_access_level(spreadsheet["id"], 0)

    level = explicit if _RANK[explicit] >= _RANK[anonymous] else anonymous
    if level is None:
        raise AccessDenied("No access to this spreadsheet")

    return spreadsheet["id"], level
