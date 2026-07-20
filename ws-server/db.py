"""Synchronous DB access, run off the asyncio event loop via an executor.

Opens a fresh connection per call rather than pooling -- simplest correct
option at this app's traffic scale (a handful of concurrent editors), and
avoids stale-connection edge cases. Mirrors src/Db.php's TLS handling: the
blanket DB user has REQUIRE SSL, so ssl_ca must be set or PyMySQL (like
PHP's mysqlnd) will silently stay plaintext and get rejected as Access
Denied rather than a clear TLS error.
"""

import json
import pymysql
import pymysql.cursors

import config

_CA_PATH = "/etc/ssl/certs/ca-certificates.crt"


def _connect():
    return pymysql.connect(
        host=config.get("HOST"),
        port=int(config.get("DB_PORT")),
        user=config.get("USER"),
        password=config.get("PASSWORD"),
        database=config.get("DB_NAME"),
        charset="utf8mb4",
        cursorclass=pymysql.cursors.DictCursor,
        ssl_ca=_CA_PATH,
        ssl_verify_cert=False,
        ssl_verify_identity=False,
        autocommit=True,
    )


def fetch_tab(tab_id):
    """Returns {id, spreadsheet_id, deleted_at} or None."""
    with _connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id, spreadsheet_id, deleted_at FROM tabs WHERE id = %s",
                (tab_id,),
            )
            return cur.fetchone()


def fetch_spreadsheet(spreadsheet_id):
    """Returns {id, owner_id, deleted_at} or None."""
    with _connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id, owner_id, deleted_at FROM spreadsheets WHERE id = %s",
                (spreadsheet_id,),
            )
            return cur.fetchone()


def fetch_access_level(spreadsheet_id, user_id):
    """Explicit access_level for this user on this spreadsheet, or None."""
    with _connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """SELECT access_level FROM spreadsheet_access
                   WHERE spreadsheet_id = %s AND user_id = %s""",
                (spreadsheet_id, user_id),
            )
            row = cur.fetchone()
            return row["access_level"] if row else None


def fetch_current_state(tab_id):
    """Returns (sequence, data_dict). (0, {}) if the tab has no history yet."""
    with _connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """SELECT sequence, data FROM spreadsheet_history
                   WHERE tab_id = %s ORDER BY sequence DESC LIMIT 1""",
                (tab_id,),
            )
            row = cur.fetchone()
            if row is None:
                return 0, {}
            data = row["data"]
            if isinstance(data, (bytes, str)):
                data = json.loads(data)
            return row["sequence"], data


def insert_history_row(tab_id, sequence, data, saved_by, saved_by_ip_packed, saved_by_name):
    with _connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """INSERT INTO spreadsheet_history
                   (tab_id, sequence, data, saved_by, saved_by_ip, saved_by_name)
                   VALUES (%s, %s, %s, %s, %s, %s)""",
                (
                    tab_id,
                    sequence,
                    json.dumps(data),
                    saved_by,
                    saved_by_ip_packed,
                    saved_by_name,
                ),
            )
