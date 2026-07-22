# TODO

Final hardening/cleanup backlog. Nothing here is urgent or a known active
exploit — see security-concerns.md for full detail on each.

- **Narrow the `blanket` MySQL user's grants.** `SHOW GRANTS` shows
  `ALL PRIVILEGES ON blanket.*`; the app only ever does
  SELECT/INSERT/UPDATE/DELETE through prepared statements, never DDL.
  Narrowing reduces blast radius if the app is ever compromised. Data-model/
  access decision — flagging for a decision rather than just running it:
  ```sql
  REVOKE ALL PRIVILEGES ON blanket.* FROM 'blanket'@'dogmanjr.net';
  GRANT SELECT, INSERT, UPDATE, DELETE ON blanket.* TO 'blanket'@'dogmanjr.net';
  ```
  (Confirm nothing — migrations included — relies on this same credential
  having DDL rights before running this.)

- **Dedicated service account for `blanket-ws`**, instead of sharing
  `www-data` with the PHP app (security-concerns.md #2). Recommended, not
  mandatory — narrows blast radius if either service is compromised, at
  the cost of new-user setup. Root-only.

- **JWTs land in Apache's access logs** as a URL query parameter on every
  WS handshake (security-concerns.md #3). Worth a custom `LogFormat` that
  redacts the query string for `/blanket/ws/`, or a deliberate decision
  that log retention/access is fine as-is. Root-only.

- **No `Origin` header validation on the WS handshake** (security-concerns.md
  #5). Low priority — the main exploit path is already closed by JWTs
  living in `localStorage`, not a cookie. Code-level, no root needed.
