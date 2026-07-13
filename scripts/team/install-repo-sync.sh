#!/bin/bash
# Register the host-side LBox repository sync job on the operating Mac mini.
# Re-running this script replaces the launchd job in place.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LABEL="com.nanoclaw.repo-sync"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
STATE_DIR="$HOME/.local/state/aimclaw-repo-sync"
LOG_FILE="$STATE_DIR/sync.log"

mkdir -p "$HOME/Library/LaunchAgents" "$STATE_DIR"

# Fail interactively before installing a background job when GitHub access is
# unavailable. This also prepares a complete first checkout for the mount.
"$REPO_ROOT/scripts/team/sync-repos.sh"

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
    <string>$REPO_ROOT/scripts/team/sync-repos.sh</string>
  </array>
  <key>StartInterval</key>
  <integer>900</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>$LOG_FILE</string>
  <key>StandardErrorPath</key>
  <string>$LOG_FILE</string>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"

echo "Installed and loaded $LABEL"
echo "  repositories: $HOME/lbox-repos"
echo "  interval:     every 15 minutes"
echo "  status:       $HOME/lbox-repos/.aimclaw-sync-status.json"
echo "  log:          $LOG_FILE"
