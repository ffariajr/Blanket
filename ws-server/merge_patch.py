"""RFC 7396 JSON Merge Patch.

Design decision (nothing specified this before now): the live `new_edit`
wire payload is a merge patch applied to the in-memory document, not a
full replacement -- keeps live edits small regardless of document size.
Persistence to spreadsheet_history is always the resulting FULL document,
never the patch itself (per the decision to drop the edit-log/delta
persistence idea). The frontend must produce patches in this shape, e.g.
{"cells": {"A1": {"value": "hello"}}}; a key set to null deletes that key.
"""


def apply_merge_patch(target, patch):
    if not isinstance(patch, dict):
        return patch
    if not isinstance(target, dict):
        target = {}
    result = dict(target)
    for key, value in patch.items():
        if value is None:
            result.pop(key, None)
        elif isinstance(value, dict):
            result[key] = apply_merge_patch(result.get(key), value)
        else:
            result[key] = value
    return result
