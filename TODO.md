# TODO

## Testing

- **Full exhaustive testing of the mobile version**, in subagents (same
  pattern as the earlier desktop-feature testing workflows) — hasn't been
  done yet. A real (headless) Chromium can actually be driven on this box
  now — see the `browser-testing-workaround` memory — so this can use real
  browser testing with a mobile viewport/user-agent set via Chrome's own
  CLI flags, not just jsdom. Still worth a manual spot-check by Fernando on
  an actual phone for anything genuinely touch/gesture-specific.

## Step 2 - Hardening & Cleanup

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

- ~~**Dedicated service account for `blanket-ws`**~~ — considered, declined
  (security-concerns.md #2): `blanket-ws` is Blanket-specific by design
  (protocol, `tab_id` routing, auth model), so it could never sensibly be
  shared with a future unrelated site on this box anyway.

- **JWTs land in Apache's access logs** (security-concerns.md #3) — decided
  against the `LogFormat` mitigation (never applied, both vhosts confirmed
  still plain `combined`). Root-fixing this instead: moving the token from
  the WS URL's query string into the first `hello` message, so it never
  appears in Apache's logs at all. In progress — check back once that
  lands before removing this item.

- ~~**No `Origin` header validation on the WS handshake**~~ — done, commit
  `303a435`, live since the `blanket-ws` restart.
