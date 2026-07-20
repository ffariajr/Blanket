# Blanket — database schema

Generated from the live `blanket` database on `db.dogmanjr.net`, reflecting
migrations `0001_initial_schema.sql` through
`0005_drop_tab_attribution_columns.sql`. Source of truth is
`db/migrations/`; this file is a readable snapshot, not authoritative — if
it ever disagrees with the migrations, the migrations win.

## users

```
+---------------+-----------------+------+-----+-------------------+-------------------+
| Field         | Type            | Null | Key | Default           | Extra             |
+---------------+-----------------+------+-----+-------------------+-------------------+
| id            | bigint unsigned | NO   | PRI | NULL              | auto_increment    |
| username      | varchar(64)     | NO   | UNI | NULL              |                    |
| email         | varchar(255)    | NO   | UNI | NULL              |                    |
| password_hash | varchar(255)    | NO   |     | NULL              |                    |
| display_name  | varchar(128)    | NO   |     | NULL              |                    |
| is_admin      | tinyint(1)      | NO   |     | 0                 |                    |
| enabled       | tinyint(1)      | NO   |     | 1                 |                    |
| created_at    | timestamp       | NO   |     | CURRENT_TIMESTAMP | DEFAULT_GENERATED |
| deleted_at    | timestamp       | YES  |     | NULL              |                    |
+---------------+-----------------+------+-----+-------------------+-------------------+
```

```
+---------------------------+----------+------------+-----------+
| Constraint                | Columns  | References | On Delete |
+---------------------------+----------+------------+-----------+
| PRIMARY KEY                | id       | -          | -         |
| UNIQUE uq_users_username   | username | -          | -         |
| UNIQUE uq_users_email      | email    | -          | -         |
+---------------------------+----------+------------+-----------+
```

Row `id = 0` is a reserved sentinel ("anonymous" / no authenticated user),
seeded by `0002_seed_anonymous_user.sql`. Users are never hard-deleted,
only soft-deleted via `deleted_at` — every FK below that points at `users`
relies on this, since history/attribution must survive permanently.
`enabled` is a separate, independent toggle (an admin can suspend login
without touching `deleted_at`'s archive semantics).

## spreadsheets

```
+------------+-----------------+------+-----+-------------------+------------------------------------------------+
| Field      | Type            | Null | Key | Default           | Extra                                           |
+------------+-----------------+------+-----+-------------------+------------------------------------------------+
| id         | bigint unsigned | NO   | PRI | NULL              | auto_increment                                  |
| owner_id   | bigint unsigned | NO   | MUL | NULL              |                                                  |
| title      | varchar(255)    | NO   |     | NULL              |                                                  |
| created_at | timestamp       | NO   |     | CURRENT_TIMESTAMP | DEFAULT_GENERATED                               |
| updated_at | timestamp       | NO   |     | CURRENT_TIMESTAMP | DEFAULT_GENERATED on update CURRENT_TIMESTAMP   |
| deleted_at | timestamp       | YES  |     | NULL              |                                                  |
+------------+-----------------+------+-----+-------------------+------------------------------------------------+
```

```
+----------------------------+-----------+------------+-----------+
| Constraint                 | Columns   | References | On Delete |
+----------------------------+-----------+------------+-----------+
| PRIMARY KEY                 | id        | -          | -         |
| KEY idx_spreadsheets_owner  | owner_id  | -          | -         |
| FK fk_spreadsheets_owner    | owner_id  | users(id)  | RESTRICT  |
+----------------------------+-----------+------------+-----------+
```

Soft-deleted via `deleted_at` (hides from the owner). Only a real admin
action ever issues an actual `DELETE`, which cascades to `tabs` (and
transitively to `spreadsheet_access` and `spreadsheet_history`).

## tabs

```
+----------------+-----------------+------+-----+-------------------+-------------------+
| Field          | Type            | Null | Key | Default           | Extra             |
+----------------+-----------------+------+-----+-------------------+-------------------+
| id             | bigint unsigned | NO   | PRI | NULL              | auto_increment    |
| spreadsheet_id | bigint unsigned | NO   | MUL | NULL              |                    |
| name           | varchar(255)    | NO   |     | NULL              |                    |
| position       | int unsigned    | NO   |     | NULL              |                    |
| created_at     | timestamp       | NO   |     | CURRENT_TIMESTAMP | DEFAULT_GENERATED |
| deleted_at     | timestamp       | YES  |     | NULL              |                    |
+----------------+-----------------+------+-----+-------------------+-------------------+
```

```
+---------------------------+----------------+----------------+-----------+
| Constraint                | Columns        | References     | On Delete |
+---------------------------+----------------+----------------+-----------+
| PRIMARY KEY                | id             | -              | -         |
| KEY idx_tabs_spreadsheet   | spreadsheet_id | -              | -         |
| FK fk_tabs_spreadsheet     | spreadsheet_id | spreadsheets(id) | CASCADE |
+---------------------------+----------------+----------------+-----------+
```

One row per tab/sheet within a spreadsheet. `spreadsheet_history` links to
this table (via `tab_id`), not directly to `spreadsheets`.

No `created_by`/`deleted_by` columns here — tab creation and deletion
attribution is *inferred* from `spreadsheet_history` instead of stored
directly on this row. This requires two app-level rules the schema can't
enforce on its own:
- Tab creation MUST write an initial `spreadsheet_history` row
  (`sequence = 1`) for the new `tab_id`, even if the tab starts empty,
  attributed via `saved_by`/`saved_by_ip`/`saved_by_name` to whoever
  created it. "Who created tab X" = `saved_by` of the row with
  `MIN(sequence)` for that `tab_id`.
- Tab deletion MUST write a final `spreadsheet_history` row for that
  `tab_id` at the moment of deletion (flushing current content),
  attributed to whoever deleted it — and no further row may ever be
  written for that `tab_id` afterward, or the inference below breaks.
  "Who deleted tab X" = `saved_by` of the row with `MAX(sequence)` for
  that `tab_id`, when `tabs.deleted_at IS NOT NULL`.

## spreadsheet_access

```
+----------------+----------------------+------+-----+-------------------+-------------------+
| Field          | Type                 | Null | Key | Default           | Extra             |
+----------------+----------------------+------+-----+-------------------+-------------------+
| id             | bigint unsigned      | NO   | PRI | NULL              | auto_increment    |
| spreadsheet_id | bigint unsigned      | NO   | MUL | NULL              |                    |
| user_id        | bigint unsigned      | NO   | MUL | 0                 |                    |
| access_level   | enum('view','edit')  | NO   |     | NULL              |                    |
| created_at     | timestamp            | NO   |     | CURRENT_TIMESTAMP | DEFAULT_GENERATED |
+----------------+----------------------+------+-----+-------------------+-------------------+
```

```
+------------------------------------+---------------------------+----------------+-----------+
| Constraint                         | Columns                   | References     | On Delete |
+------------------------------------+---------------------------+----------------+-----------+
| PRIMARY KEY                         | id                         | -              | -         |
| UNIQUE uq_access_spreadsheet_user   | (spreadsheet_id, user_id)  | -              | -         |
| KEY idx_access_user                 | user_id                    | -              | -         |
| FK fk_access_spreadsheet            | spreadsheet_id             | spreadsheets(id) | CASCADE |
| FK fk_access_user                   | user_id                    | users(id)      | RESTRICT  |
+------------------------------------+---------------------------+----------------+-----------+
```

`user_id = 0` is the anonymous access policy row for that spreadsheet (at
most one, enforced by the unique key). Absence of a row = no access. The
owner never gets a row here — full access is implied by
`spreadsheets.owner_id` instead. `access_level` stays an ENUM deliberately:
MySQL stores it as a 1-byte integer internally, smaller and faster than a
VARCHAR, and the two-tier access model is a stable requirement. No
`granted_by` — only an owner or admin can grant access, and that actor
isn't recorded.

## spreadsheet_history

```
+---------------+-----------------+------+-----+-------------------+-------------------+
| Field         | Type            | Null | Key | Default           | Extra             |
+---------------+-----------------+------+-----+-------------------+-------------------+
| id            | bigint unsigned | NO   | PRI | NULL              | auto_increment    |
| tab_id        | bigint unsigned | NO   | MUL | NULL              |                    |
| sequence      | int unsigned    | NO   |     | NULL              |                    |
| data          | json            | NO   |     | NULL              |                    |
| saved_by      | bigint unsigned | NO   | MUL | 0                 |                    |
| saved_by_ip   | varbinary(16)   | NO   |     | NULL              |                    |
| saved_by_name | varchar(128)    | NO   |     | Anonymous         |                    |
| created_at    | timestamp       | NO   |     | CURRENT_TIMESTAMP | DEFAULT_GENERATED |
+---------------+-----------------+------+-----+-------------------+-------------------+
```

```
+------------------------------+-------------------+------------+-----------+
| Constraint                   | Columns           | References | On Delete |
+------------------------------+-------------------+------------+-----------+
| PRIMARY KEY                   | id                | -          | -         |
| UNIQUE uq_history_tab_sequence | (tab_id, sequence) | -        | -         |
| FK fk_history_tab             | tab_id            | tabs(id)   | CASCADE   |
| FK fk_history_saved_by        | saved_by          | users(id)  | RESTRICT  |
+------------------------------+-------------------+------------+-----------+
```

Append-only: one full JSON snapshot of one tab per save, never mutated or
deleted. "Current state of a tab" = the row with `MAX(sequence)` for that
`tab_id`. "Restore" = copy an old row's `data` forward as a new latest
sequence for that tab — a per-tab operation, not a whole-spreadsheet one
(each tab has its own independent history). `saved_by_ip` is packed via
`INET6_ATON()`/`inet_pton()`; the app must resolve it from
`X-Forwarded-For` since Apache sits in front as a reverse proxy.
`saved_by_name` is server-derived from `users.display_name` when
`saved_by <> 0`, and client-supplied (unverified) when anonymous.

## Entity relationships

```
users ----------------< spreadsheets >---------------- tabs >---------------- spreadsheet_history
  ^  \                        |                                                      |
  |   \                       v                                                      |
  |    \-----------< spreadsheet_access                                              |
  |                     (also user_id -> users)                                      |
  \-------------------------------------------------------------------------- saved_by
```

- `spreadsheets.owner_id` → `users.id`
- `tabs.spreadsheet_id` → `spreadsheets.id` (CASCADE)
- `spreadsheet_history.tab_id` → `tabs.id` (CASCADE)
- `spreadsheet_history.saved_by` → `users.id`
- `spreadsheet_access.spreadsheet_id` → `spreadsheets.id` (CASCADE)
- `spreadsheet_access.user_id` → `users.id`

Tab creation/deletion attribution is *inferred* through
`spreadsheet_history.saved_by`, not a direct edge from `tabs` to `users` —
see the app-level rules noted under the `tabs` section above.
