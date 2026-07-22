#!/usr/bin/env bash
#
# Installs the PHP/web-facing part of Blanket from this dev directory into
# the Apache-served deploy directory. Does not touch the Python WebSocket
# server (deployed separately, not under the docroot) or any dev-only docs.
#
# Defaults to a dry run. Pass --apply to actually write.
set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST_DIR="/var/www/church/blanket"

DRY_RUN=1
for arg in "$@"; do
  case "$arg" in
    --apply) DRY_RUN=0 ;;
    --dry-run) DRY_RUN=1 ;;
    *)
      echo "Unknown argument: $arg" >&2
      echo "Usage: $0 [--apply|--dry-run]" >&2
      exit 2
      ;;
  esac
done

if [ ! -d "$DEST_DIR" ]; then
  echo "Deploy target $DEST_DIR does not exist" >&2
  exit 1
fi

RSYNC_ARGS=(
  -av --delete
  # -a implies preserving mtime/perms/owner/group. This deploy directory
  # is www-data owned; the claude user only has group write on its
  # contents, not ownership of the directory entries themselves -- rsync
  # trying to sync any of those four attributes to match the source
  # fails with "Operation not permitted" (exit 23) even though the actual
  # file *content* transfers correctly every time (confirmed repeatedly:
  # first mtime, then perms, then -- once new top-level entries showed up
  # in a later deploy -- group too). Skip all four; content transfer
  # doesn't need them, and www-data ending up owning the tree isn't
  # something claude can do here anyway (would need chgrp as root).
  --omit-dir-times
  --no-perms
  --no-owner
  --no-group
  # No trailing slash: a trailing slash only matches a *directory* named
  # .git, which is true in a normal checkout but not in a git worktree
  # (there .git is a plain file pointing back at the main repo) -- a
  # trailing-slash-only pattern would silently let that file sync straight
  # into the public docroot if this script is ever run from a worktree.
  --exclude '.git'
  --exclude '.gitignore'
  # Any dotenv-style secrets file (.mysql.env, .app.env, and anything else
  # added later) -- a bare '.mysql.env'/'.env'/'.env.*' list here once
  # missed .app.env entirely when it was added, letting it rsync straight
  # into the public docroot. .htaccess also blocks *.env and dotfiles from
  # being served, but this should never rely on that as the only layer.
  --exclude '*.env'
  --exclude 'install.sh'
  --exclude 'dev-router.php'
  --exclude 'README.md'
  --exclude 'MACHINE.md'
  --exclude 'REQUIREMENTS.md'
  --exclude 'ACCESS.md'
  --exclude 'CELL_SCHEMA.md'
  --exclude 'security-concerns.md'
  --exclude 'db/'
  --exclude 'deploy/'
  --exclude 'tests/'
  --exclude 'ws-server/'
  --exclude 'venv/'
  --exclude '.venv/'
  --exclude '__pycache__/'
  --exclude '*.pyc'
  --exclude '.claude/'
)

if [ "$DRY_RUN" -eq 1 ]; then
  echo "DRY RUN — showing what would change. Re-run with --apply to install."
  rsync "${RSYNC_ARGS[@]}" --dry-run "$SRC_DIR"/ "$DEST_DIR"/
else
  echo "Installing Blanket from $SRC_DIR to $DEST_DIR"
  rsync "${RSYNC_ARGS[@]}" "$SRC_DIR"/ "$DEST_DIR"/
  # Apache/mod_php run as www-data, which is not a member of the claude
  # group -- files land here owned claude:claude, so without this www-data
  # can't read anything (confirmed: .htaccess unreadable -> Apache 403s
  # everything "to be safe"). This app is meant to be publicly served, so
  # world-readable app code is normal; secrets (.mysql.env/.app.env) are
  # never synced by this script in the first place, deliberately, and need
  # their own permission handling (see deploy/README.md).
  # -mindepth 1: the deploy root itself is owned by www-data (already
  # readable/traversable by it as owner) and not by claude, so chmod'ing
  # it directly fails with "Operation not permitted" -- only its contents
  # need this. Ownership under the root is a mix in practice -- some
  # entries ended up www-data-owned from an earlier deploy (before
  # --no-owner/--no-group were added above), most are claude-owned.
  # chmod fails on ones claude doesn't own, but that's harmless: a
  # www-data-owned file/dir already gives www-data full access as owner,
  # it doesn't need this fix at all. Don't let those failures abort the
  # script -- only ones claude actually owns can be fixed here anyway.
  find "$DEST_DIR" -mindepth 1 -type d -exec chmod o+rx {} + 2>/dev/null || true
  find "$DEST_DIR" -mindepth 1 -type f -exec chmod o+r {} + 2>/dev/null || true
  echo "Done."
fi
