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
  -av --delete --delete-excluded
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
  # .mysql.env/.app.env are deliberately never synced by this script (see
  # deploy/README.md -- they're hand-copied once, separately) but they
  # DO live in $DEST_DIR at runtime, and src/Config.php reads them off
  # disk on every request, not just at deploy time. When --delete-excluded
  # was added below, these two stopped being merely "not transferred" and
  # became "actively deleted every deploy" -- exactly the same exclude
  # pattern that correctly removes a stray leak also correctly nukes a
  # file this app depends on to run at all if that file isn't also
  # exempted from deletion specifically. This actually happened: an
  # --apply run deleted both, and the live site 500'd on every API call
  # (Config.php had nothing to load) until they were manually restored.
  # `P` (protect) means "never delete this on the receiving side," which
  # is exactly the distinction needed: excluded from transfer, protected
  # from deletion. These must stay ahead of the allowlist below.
  --filter 'P /.mysql.env'
  --filter 'P /.app.env'
  # Allowlist, not a denylist: only these paths are ever web-facing. A
  # denylist here once let a stray root-level scratch file (next.txt,
  # containing private notes) sync straight into the public docroot,
  # world-readable, simply because nobody had added its name to an
  # exclude list -- any *future* stray file (notes, drafts, anything
  # dropped at the repo root) would have silently leaked the same way.
  # An allowlist can't have that failure mode: a new root-level file is
  # excluded by default and only becomes web-facing by deliberate choice.
  # --delete-excluded (above) means anything not on this list is actively
  # removed from the deploy target too, cleaning up past leaks like
  # next.txt automatically on the next deploy.
  --include '/.htaccess'
  --include '/index.html'
  --include '/index.php'
  --include '/assets/'
  --include '/assets/**'
  --include '/src/'
  --include '/src/**'
  --include '/vendor/'
  --include '/vendor/**'
  --exclude '*'
)

if [ "$DRY_RUN" -eq 1 ]; then
  echo "DRY RUN — showing what would change. Re-run with --apply to install."
  rsync "${RSYNC_ARGS[@]}" --dry-run "$SRC_DIR"/ "$DEST_DIR"/
else
  echo "Installing Blanket from $SRC_DIR to $DEST_DIR"
  # bin/create-admin.php is not on the allowlist above and so is always
  # slated for deletion, but it (and its parent dir) are www-data-owned
  # from an older deploy, before ownership hygiene was fixed -- claude
  # can't delete a file it doesn't own. rsync reports that as exit 23
  # ("partial transfer due to error"), which under `set -e` used to abort
  # the whole script *before* the cache-busting stamping step below ever
  # ran, silently leaving a deploy's index.html/app.js/grid.js/ws.js with
  # unstamped __DEPLOY_VERSION__ placeholders. Tolerate exit 23
  # specifically (the actual file content still transfers correctly; only
  # the stray delete fails) and keep going -- anything else still aborts.
  set +e
  rsync "${RSYNC_ARGS[@]}" "$SRC_DIR"/ "$DEST_DIR"/
  rsync_status=$?
  set -e
  if [ "$rsync_status" -ne 0 ] && [ "$rsync_status" -ne 23 ]; then
    echo "rsync failed (exit $rsync_status)" >&2
    exit "$rsync_status"
  fi
  if [ "$rsync_status" -eq 23 ]; then
    echo "Note: rsync exited 23 (partial transfer) -- likely a www-data-owned leftover claude can't delete (e.g. bin/create-admin.php). Ask fvf to remove it as root; continuing with the rest of the deploy." >&2
  fi
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
  find "$DEST_DIR" -mindepth 1 -type f ! -name '.mysql.env' ! -name '.app.env' -exec chmod o+r {} + 2>/dev/null || true
  # Secrets: group-readable (www-data can read them), never world-readable.
  # .htaccess already blocks *.env by extension regardless, but on-disk
  # permissions shouldn't rely on that alone -- any local account on this
  # shared box could otherwise read live DB credentials off disk directly.
  chmod 640 "$DEST_DIR/.mysql.env" "$DEST_DIR/.app.env" 2>/dev/null || true

  # Cache-busting: index.html references assets/{app.js,app.css} with a
  # __DEPLOY_VERSION__ placeholder, and app.js/grid.js/ws.js carry the same
  # placeholder on their own ES module imports of each other (app.js ->
  # api.js/grid.js/ws.js, grid.js -> formulas.js/api.js, ws.js -> api.js) --
  # stamping only index.html would leave those imports as bare unversioned
  # URLs, so a plain page reload could still serve a browser-cached stale
  # copy of exactly the files most likely to matter (e.g. grid.js's
  # applyRemote) even though app.js itself got a fresh fetch. Stamp all of
  # them with the same value so a single deploy is one consistent version
  # bump across the whole module graph. Apache sends no Cache-Control on
  # static files here (mod_headers isn't enabled, needs root) and, more
  # importantly, ES modules are fetched once per page load regardless of
  # HTTP caching -- this doesn't fix an already-open tab (only a reload
  # does), but guarantees any *new* page load gets current code.
  DEPLOY_VERSION="$(date +%s)"
  sed -i "s/__DEPLOY_VERSION__/$DEPLOY_VERSION/g" \
    "$DEST_DIR/index.html" \
    "$DEST_DIR/assets/js/app.js" \
    "$DEST_DIR/assets/js/grid.js" \
    "$DEST_DIR/assets/js/ws.js"
  echo "Done."
fi
