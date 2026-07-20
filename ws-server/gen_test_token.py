import sys
import time
import jwt
import config

user_id, username, display_name, is_admin = sys.argv[1:5]
payload = {
    "sub": user_id,  # string, per RFC 7519 StringOrURI -- see src/Auth/Jwt.php
    "username": username,
    "display_name": display_name,
    "is_admin": is_admin == "1",
    "iat": int(time.time()),
    "exp": int(time.time()) + 3600,
}
print(jwt.encode(payload, config.get("JWT_SECRET"), algorithm="HS256"))
