"""Config loader mirroring src/Config.php's safe line-based .env parsing.

The DB password contains a literal '#' character. A naive parser (or
python-dotenv's default comment handling) would treat it as a mid-line
comment and silently truncate the value. This only ever treats a line as a
comment if '#' is the first non-whitespace character; the value after the
first '=' is taken verbatim.
"""

import os

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

_DEFAULTS = {
    "DB_NAME": "blanket",
    "DB_PORT": "3306",
}

_values = None


def _merge_env_file(path, values):
    if not os.path.isfile(path):
        raise RuntimeError(f"Missing required config file: {path}")
    with open(path, "r", encoding="utf-8") as f:
        for raw_line in f:
            line = raw_line.strip()
            if line == "" or line.startswith("#"):
                continue
            if "=" not in line:
                continue
            key, value = line.split("=", 1)
            values[key.strip()] = value


def _load():
    global _values
    if _values is not None:
        return _values
    values = dict(_DEFAULTS)
    for filename in (".mysql.env", ".app.env"):
        _merge_env_file(os.path.join(_REPO_ROOT, filename), values)
    _values = values
    return _values


def get(key):
    values = _load()
    if key not in values:
        raise RuntimeError(f"Missing config value: {key}")
    return values[key]
