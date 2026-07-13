#!/bin/bash
# Keep the host-owned LBox reference repositories current for read-only
# container mounts. The checkout directory is dedicated to AimClaw: each run
# discards tracked local changes and checks out origin's default branch at the
# fetched commit.

set -u
PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
export GIT_TERMINAL_PROMPT=0

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
REPOS_FILE="${LBOX_REPOS_FILE:-$REPO_ROOT/container/skills/lbox-product-code-search/repos.txt}"
REPOS_DIR="${LBOX_REPOS_DIR:-$HOME/lbox-repos}"
STATE_DIR="${LBOX_REPOS_STATE_DIR:-$HOME/.local/state/aimclaw-repo-sync}"
LOCK_DIR="$STATE_DIR/lock"
STATUS_FILE="$REPOS_DIR/.aimclaw-sync-status.json"

mkdir -p "$REPOS_DIR" "$STATE_DIR"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"
}

write_status() {
  local state="$1" failed="$2" tmp
  tmp="$STATUS_FILE.tmp"
  printf '{"state":"%s","at":"%s","failed":%s}\n' \
    "$state" "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$failed" > "$tmp"
  mv "$tmp" "$STATUS_FILE"
}

if [ ! -f "$REPOS_FILE" ]; then
  log "repository list not found: $REPOS_FILE"
  write_status failed 1
  exit 1
fi

# launchd can overlap a slow initial clone with the next interval. Reclaim a
# stale lock after a crash, but never run two fetch/checkouts concurrently.
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  holder="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
  if [ -n "$holder" ] && kill -0 "$holder" 2>/dev/null; then
    log "repository sync already running (pid $holder); deferring"
    exit 0
  fi
  rm -rf "$LOCK_DIR"
  if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    log "lock contention while reclaiming; deferring"
    exit 0
  fi
fi
echo $$ > "$LOCK_DIR/pid"
trap 'rm -rf "$LOCK_DIR"' EXIT

write_status syncing 0
failed=0

while read -r name url; do
  [ -z "$name" ] && continue
  case "$name" in
    *[!a-zA-Z0-9._-]*)
      log "invalid repository name in $REPOS_FILE: $name"
      failed=$((failed + 1))
      continue
      ;;
  esac
  if [ -z "$url" ]; then
    log "missing repository URL for $name"
    failed=$((failed + 1))
    continue
  fi

  target="$REPOS_DIR/$name"
  if [ ! -e "$target" ]; then
    tmp="$target.clone.$$"
    rm -rf "$tmp"
    log "cloning $name"
    if git clone -- "$url" "$tmp" && mv "$tmp" "$target"; then
      log "cloned $name"
    else
      rm -rf "$tmp"
      log "clone failed: $name"
      failed=$((failed + 1))
      continue
    fi
  elif [ ! -d "$target/.git" ]; then
    log "target exists but is not a Git repository: $target"
    failed=$((failed + 1))
    continue
  fi

  if ! git -C "$target" remote set-url origin "$url"; then
    log "cannot set origin URL: $name"
    failed=$((failed + 1))
    continue
  fi
  log "fetching $name"
  if ! git -C "$target" fetch --prune origin; then
    log "fetch failed: $name"
    failed=$((failed + 1))
    continue
  fi

  remote_head="$(git -C "$target" symbolic-ref -q --short refs/remotes/origin/HEAD || true)"
  if [ -z "$remote_head" ]; then
    if git -C "$target" show-ref --verify --quiet refs/remotes/origin/main; then
      remote_head=origin/main
    elif git -C "$target" show-ref --verify --quiet refs/remotes/origin/master; then
      remote_head=origin/master
    else
      log "cannot resolve origin default branch: $name"
      failed=$((failed + 1))
      continue
    fi
  fi

  if ! git -C "$target" checkout --detach --force "$remote_head" >/dev/null; then
    log "checkout failed: $name ($remote_head)"
    failed=$((failed + 1))
    continue
  fi

  log "ready $name at $(git -C "$target" rev-parse --short HEAD)"
done < "$REPOS_FILE"

if [ "$failed" -gt 0 ]; then
  write_status failed "$failed"
  log "repository sync finished with $failed failure(s)"
  exit 1
fi

write_status ok 0
log "repository sync complete"
