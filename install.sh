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
  --exclude '.git/'
  --exclude '.gitignore'
  --exclude '.mysql.env'
  --exclude '.env'
  --exclude '.env.*'
  --exclude '*.env'
  --exclude 'install.sh'
  --exclude 'dev-router.php'
  --exclude 'README.md'
  --exclude 'MACHINE.md'
  --exclude 'REQUIREMENTS.md'
  --exclude 'ACCESS.md'
  --exclude 'CELL_SCHEMA.md'
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
  echo "Done."
fi
