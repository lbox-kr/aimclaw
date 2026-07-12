#!/bin/bash
# scripts/team/deploy.sh — mini auto-deploy: converge onto origin/main and apply it.
#
# Run by launchd (com.nanoclaw.team-deploy) every 15 minutes and immediately
# when ~/nanoclaw-deploy/trigger changes (written by the team-update container
# skill). Harness-only changes need no restart; code changes build, stamp the
# upgrade marker, and kickstart the service. On any failure the running
# process is left alone and the same target is retried on the next run.
#
# Success is tracked in deployed-sha, stamped only after a fully applied
# deploy. Never infer success from HEAD: a failed attempt leaves HEAD at the
# target, and a HEAD-based check would mask the failure as up-to-date forever.
#
# Status contract (read by container/skills/team-update):
#   ~/nanoclaw-deploy/status.json  {state, mode, from, to, at, detail}
#   ~/nanoclaw-deploy/deploy.log   append-only detail log
#   ~/nanoclaw-deploy/deployed-sha last successfully deployed commit

set -u
PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

cd "$(dirname "${BASH_SOURCE[0]}")/../.." || exit 1
REPO_ROOT="$PWD"
DEPLOY_DIR="$HOME/nanoclaw-deploy"
LOCK_DIR="$DEPLOY_DIR/.lock"
mkdir -p "$DEPLOY_DIR"

exec >>"$DEPLOY_DIR/deploy.log" 2>&1

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"
}

# launchd WatchPaths needs the trigger file to exist: while it is missing,
# launchd falls back to watching the whole directory, and our own status/log
# writes would re-fire the job in a tight loop.
[ -e "$DEPLOY_DIR/trigger" ] || touch "$DEPLOY_DIR/trigger"

# Single-flight lock with staleness recovery — a lock left behind by a crash,
# SIGKILL, or power loss (EXIT trap never ran) must not disable deploys
# forever, so a lock whose recorded pid is dead is reclaimed.
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  holder="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
  if [ -n "$holder" ] && kill -0 "$holder" 2>/dev/null; then
    log "deploy already running (pid $holder); deferring"
    exit 0
  fi
  log "reclaiming stale lock (pid ${holder:-unknown} not running)"
  rm -rf "$LOCK_DIR"
  if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    log "lock contention while reclaiming; deferring"
    exit 0
  fi
fi
echo $$ > "$LOCK_DIR/pid"
trap 'rm -rf "$LOCK_DIR"' EXIT

FROM=""
TO=""

# write_status <state> <mode> <detail> — atomic tmp→mv so the container skill
# never reads a half-written file.
write_status() {
  local state="$1" mode="$2" detail="$3"
  local at tmp
  at="$(date '+%Y-%m-%dT%H:%M:%S%z')"
  tmp="$DEPLOY_DIR/.status.json.tmp"
  printf '{"state":"%s","mode":"%s","from":"%s","to":"%s","at":"%s","detail":"%s"}\n' \
    "$state" "$mode" "$FROM" "$TO" "$at" "$detail" > "$tmp"
  mv "$tmp" "$DEPLOY_DIR/status.json"
  log "status: state=$state mode=$mode from=$FROM to=$TO detail=$detail"
}

log "deploy run started (repo: $REPO_ROOT)"

if ! git fetch origin main; then
  write_status failed "" "git fetch origin main failed"
  exit 1
fi

# Pin the target now — `git pull` would fetch again and could silently pick up
# a commit pushed mid-run that the classification below never saw.
TARGET="$(git rev-parse origin/main)"
LAST_DEPLOYED="$(cat "$DEPLOY_DIR/deployed-sha" 2>/dev/null || true)"
if [ -z "$LAST_DEPLOYED" ] || ! git cat-file -e "$LAST_DEPLOYED^{commit}" 2>/dev/null; then
  LAST_DEPLOYED="$(git rev-parse HEAD)"
fi

FROM="$(git rev-parse --short "$LAST_DEPLOYED")"
TO="$(git rev-parse --short "$TARGET")"

mark_deployed() {
  printf '%s\n' "$TARGET" > "$DEPLOY_DIR/deployed-sha"
}

if [ "$TARGET" = "$LAST_DEPLOYED" ]; then
  # A failed attempt (or a rollback force-push past one) can leave HEAD ahead
  # of the deployed target — converge so the next push fast-forwards cleanly.
  if [ "$(git rev-parse HEAD)" != "$TARGET" ]; then
    log "converging checkout back to deployed target"
    git reset --hard "$TARGET"
  fi
  mark_deployed
  write_status up-to-date "" "already at origin/main"
  exit 0
fi

# quotepath=false so non-ASCII (Korean) filenames come out verbatim instead of
# C-quoted, which would defeat the harness-path classification below.
CHANGED="$(git -c core.quotepath=false diff --name-only "$LAST_DEPLOYED" "$TARGET")"

if ! git merge --ff-only "$TARGET"; then
  # A force-pushed rollback moves origin/main behind us — follow it; the mini
  # checkout is a pure deploy target with no local work of its own.
  if git merge-base --is-ancestor "$TARGET" HEAD; then
    log "origin/main moved backwards (force push); resetting"
    git reset --hard "$TARGET"
  else
    write_status failed "" "history diverged from origin/main; manual fix needed on the mini"
    exit 1
  fi
fi

# Harness-only changes (docs, skills, templates, markdown) are picked up by
# the next container spawn — no build, no restart.
is_harness_path() {
  case "$1" in
    container/CLAUDE.md) return 0 ;;
    container/skills/*) return 0 ;;
    templates/*) return 0 ;;
    .claude/*) return 0 ;;
    docs/*) return 0 ;;
    *.md) case "$1" in */*) return 1 ;; *) return 0 ;; esac ;;
  esac
  return 1
}

MODE=harness
NEED_INSTALL=0
NEED_IMAGE=0
while IFS= read -r f; do
  [ -z "$f" ] && continue
  if ! is_harness_path "$f"; then
    MODE=code
  fi
  case "$f" in
    package.json|pnpm-lock.yaml) NEED_INSTALL=1 ;;
  esac
  case "$f" in
    container/Dockerfile|container/cli-tools.json|container/install-cli-tools.sh|container/entrypoint.sh|container/agent-runner/package.json|container/agent-runner/bun.lock)
      NEED_IMAGE=1 ;;
  esac
done <<< "$CHANGED"

if [ "$MODE" = "harness" ]; then
  mark_deployed
  write_status ok harness "harness-only change; applies on next container spawn"
  exit 0
fi

if [ "$NEED_INSTALL" = "1" ]; then
  if ! pnpm install --frozen-lockfile; then
    write_status failed code "pnpm install --frozen-lockfile failed; will retry next run"
    exit 1
  fi
fi

# Keep the previous dist aside: tsc emits even when it fails (no noEmitOnError),
# and a KeepAlive restart or reboot must not boot a half-built dist.
rm -rf "$DEPLOY_DIR/dist.prev"
[ -d dist ] && cp -R dist "$DEPLOY_DIR/dist.prev"
if ! pnpm run build; then
  if [ -d "$DEPLOY_DIR/dist.prev" ]; then
    rm -rf dist
    cp -R "$DEPLOY_DIR/dist.prev" dist
  fi
  write_status failed code "pnpm run build failed; previous dist restored; old process untouched; will retry next run"
  exit 1
fi
rm -rf "$DEPLOY_DIR/dist.prev"

if [ "$NEED_IMAGE" = "1" ]; then
  if ! ./container/build.sh; then
    write_status failed code "container image build failed; old process still running; will retry next run"
    exit 1
  fi
  log "note: base image rebuilt; groups with install_packages keep their derived image until 'ncl groups restart --id <id> --rebuild'"
fi

# Stamp the upgrade marker before restart so the startup tripwire
# (package.json vs data/upgrade-state.json) lets the new process boot.
if ! pnpm exec tsx scripts/upgrade-state.ts set "" team-autodeploy; then
  write_status failed code "upgrade-state stamp failed; restart skipped; will retry next run"
  exit 1
fi

PROJECT_ROOT="$REPO_ROOT"
source setup/lib/install-slug.sh
if ! launchctl kickstart -k "gui/$(id -u)/$(launchd_label)"; then
  write_status failed code "launchctl kickstart failed; will retry next run"
  exit 1
fi

mark_deployed
write_status ok code "built and restarted"
