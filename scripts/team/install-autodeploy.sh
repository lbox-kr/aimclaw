#!/bin/bash
# scripts/team/install-autodeploy.sh — register the team auto-deploy launchd
# job on the Mac mini. MINI ONLY — never run this on a dev machine.
#
# Installs ~/Library/LaunchAgents/com.nanoclaw.team-deploy.plist which runs
# scripts/team/deploy.sh every 15 minutes and immediately whenever
# ~/nanoclaw-deploy/trigger changes (the team-update container skill writes
# it through the deploy mount). Re-running this script is safe: it reloads
# the job in place.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEPLOY_DIR="$HOME/nanoclaw-deploy"
LABEL="com.nanoclaw.team-deploy"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

mkdir -p "$DEPLOY_DIR" "$HOME/Library/LaunchAgents"

# The trigger file must exist before the job loads: launchd's WatchPaths on a
# missing file falls back to watching the whole directory, and deploy.sh's own
# status/log writes there would re-fire the job in a tight loop.
touch "$DEPLOY_DIR/trigger"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$REPO_ROOT/scripts/team/deploy.sh</string>
  </array>
  <key>WatchPaths</key>
  <array>
    <string>$DEPLOY_DIR/trigger</string>
  </array>
  <key>StartInterval</key>
  <integer>900</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$DEPLOY_DIR/launchd.log</string>
  <key>StandardErrorPath</key>
  <string>$DEPLOY_DIR/launchd.log</string>
</dict>
</plist>
EOF

# bootstrap/bootout (not legacy load/unload) so this also works from an SSH
# session — the mini is usually administered headless. Requires the user to
# have an active GUI login session (auto-login), same as the NanoClaw service.
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"

echo "Installed and loaded $LABEL"
echo "  script:  $REPO_ROOT/scripts/team/deploy.sh"
echo "  trigger: $DEPLOY_DIR/trigger (watched) + every 15 min"
echo "  status:  $DEPLOY_DIR/status.json / logs: $DEPLOY_DIR/deploy.log"
