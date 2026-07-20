"""JWT verification mirroring src/Auth/Jwt.php (HS256, same secret/claims)."""

import jwt

import config

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
    otherwise the anonymous sentinel (id 0) with the client-supplied name."""
    claims = verify(token)
    if claims is None:
        return Identity.anonymous(anonymous_name or "Anonymous")
    return Identity(
        user_id=int(claims["sub"]),
        username=claims["username"],
        display_name=claims["display_name"],
        is_admin=bool(claims["is_admin"]),
    )
