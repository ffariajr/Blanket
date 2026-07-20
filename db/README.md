# Database migrations

Numbered, applied in order, never edited after being applied to any real
database (dev or production) — a schema change is always a new file.

- `migrations/0001_initial_schema.sql` — the base tables.
- `migrations/0002_seed_anonymous_user.sql` — seeds the `users.id = 0`
  sentinel row (see comments in 0001 for why it exists).

To apply: run each file against the `blanket` database in order, e.g.

```
mysql -h db.dogmanjr.net -P 3306 --ssl-mode=REQUIRED -u blanket -p blanket < migrations/0001_initial_schema.sql
mysql -h db.dogmanjr.net -P 3306 --ssl-mode=REQUIRED -u blanket -p blanket < migrations/0002_seed_anonymous_user.sql
```

There's no migration-tracking table yet (single-developer, pre-launch) —
add one (e.g. a `schema_migrations` table recording which numbered files
have run) before this ever needs to support more than one person applying
changes.
