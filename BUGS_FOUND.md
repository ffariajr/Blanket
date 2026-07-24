# Bugs Found — Pre-Release Testing

Every finding from executing `TESTING_PLAN.md` goes here. One entry per bug,
using the template below. Do not fix inline while testing (except
`TESTING_PLAN.md`'s Section G, which is fixed directly, not logged here) —
record for Fernando to triage. Order: append new entries at the bottom in
discovery order; don't renumber existing ones.

Every entry must have gone through the same adversarial-verify step used
throughout this project: a DIFFERENT agent than the one who found it attempts
to independently reproduce it from scratch before `Verified` is set to `yes`.
An unconfirmed finding still gets logged (mark `Verified: no — see detail`),
don't discard it silently.

---

## Template (copy this block per finding)

### [NNN] Short one-line summary

- **Area:** (e.g. Formula engine / Mobile touch / Security / Performance / WS collab)
- **Severity:** critical / high / medium / low
- **Found by:** (dimension/agent name or description)
- **Verified:** yes (by: ...) / no — see detail
- **Reproduction:**
  1. ...
  2. ...
- **Expected vs. actual:**
- **Verify detail:** (what the independent verifier actually did and observed)
- **Status:** open / fixed (commit `...`) / triaged-wontfix (reason) / needs-Fernando-decision

---

## Findings

_(none yet — testing execution appends below this line)_
