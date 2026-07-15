#!/bin/bash
# Keep AimClaw's OneCLI project from providing a second GitHub access path.
# GitHub operations must go through the bounded host-side `ncl github` bridge.

set -euo pipefail

readonly RULE_PREFIX="aimclaw-host-gh-only"
readonly GITHUB_HOSTS=("api.github.com" "github.com")

if ! command -v onecli >/dev/null 2>&1; then
  echo "OneCLI CLI is not installed. Run /init-onecli first." >&2
  exit 1
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required to configure OneCLI GitHub block rules." >&2
  exit 1
fi

list_rules() {
  onecli rules list --max 100
}

for host in "${GITHUB_HOSTS[@]}"; do
  name="$RULE_PREFIX-$host"
  rules="$(list_rules)"
  id="$(jq -r --arg name "$name" '(.data? // .) | map(select(.name == $name)) | first | .id // empty' <<<"$rules")"

  if [ -n "$id" ]; then
    onecli rules update \
      --id "$id" \
      --name "$name" \
      --host-pattern "$host" \
      --action block \
      --enabled true >/dev/null
  else
    onecli rules create \
      --name "$name" \
      --host-pattern "$host" \
      --action block \
      --enabled true >/dev/null
  fi
done

rules="$(list_rules)"
for host in "${GITHUB_HOSTS[@]}"; do
  name="$RULE_PREFIX-$host"
  if ! jq -e --arg name "$name" --arg host "$host" \
    '(.data? // .) | any(.name == $name and .hostPattern == $host and .action == "block" and .enabled == true and (.agentId == null))' \
    >/dev/null <<<"$rules"; then
    echo "Failed to verify the OneCLI GitHub block rule for $host." >&2
    exit 1
  fi
done

echo "OneCLI GitHub access is blocked for the active AimClaw project."
