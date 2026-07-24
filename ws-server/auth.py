"""JWT verification mirroring src/Auth/Jwt.php (HS256, same secret/claims)."""

import jwt

import config
import db

ALGORITHM = "HS256"


class Identity:
    def __init__(self, user_id, username, display_name, is_admin):
        self.user_id = user_id
        self.username = username
        self.display_name = display_name
        self.is_admin = is_admin

    @property
    def is_anonymous(self):
        return self.user_id == 0

    @staticmethod
    def anonymous(display_name):
        return Identity(0, "__anonymous__", display_name, False)


def verify(token):
    """Returns claims dict, or None if the token is missing/invalid/expired."""
    if not token:
        return None
    try:
        return jwt.decode(token, config.get("JWT_SECRET"), algorithms=[ALGORITHM])
    except jwt.PyJWTError:
        return None


def resolve_identity(token, anonymous_name):
    """Mirrors Blanket\\Auth\\Authenticator: valid token -> that user,
    otherwise the anonymous sentinel (id 0) with the client-supplied name.

    Re-fetches the account by username on every call, mirroring
    AuthController::renew()'s live re-check -- a token's embedded claims
    are a snapshot from issuance time and must not be trusted for
    enabled/is_admin once an admin has since disabled the account or
    revoked its admin flag. A disabled/deleted/missing account resolves
    to anonymous, same as a missing/invalid/expired token, and the
    freshly-fetched is_admin (never the stale claim) is what every
    downstream access-level decision sees.

    Hits the DB, so (like access.resolve()) callers on the asyncio event
    loop must run this via run_in_executor rather than call it directly.
    """
    claims = verify(token)
    if claims is None:
        return Identity.anonymous(anonymous_name or "Anonymous")

    user = db.fetch_user_by_username(claims["username"])
    if user is None or not user["enabled"]:
        return Identity.anonymous(anonymous_name or "Anonymous")

    return Identity(
        user_id=int(user["id"]),
        username=user["username"],
        display_name=user["display_name"],
        is_admin=bool(user["is_admin"]),
    )
