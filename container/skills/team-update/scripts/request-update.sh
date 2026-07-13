#!/bin/bash

set -euo pipefail

DEPLOY_DIR="${AIMCLAW_DEPLOY_DIR:-/workspace/extra/deploy}"
DESTINATION="${1:-}"

if [ -z "$DESTINATION" ]; then
  echo "usage: request-update.sh <destination>" >&2
  exit 2
fi

if [ ! -d "$DEPLOY_DIR" ]; then
  echo "deploy mount not found: $DEPLOY_DIR" >&2
  exit 1
fi

REQUEST_ID="manual-$(date -u '+%Y%m%dT%H%M%SZ')-$$-${RANDOM}"
PROCESS_AFTER="$(date -u -d '10 seconds' '+%Y-%m-%dT%H:%M:%SZ')"
TRIGGER_TMP="$DEPLOY_DIR/.trigger.$$.tmp"
trap 'rm -f "$TRIGGER_TMP"' EXIT

TASK_PROMPT=$(cat <<EOF
AimClaw 배포가 현재 대화보다 오래 지속되거나 실행 환경을 중단해도 결과를 사용자에게 알리는 영속 one-shot 작업이다.

요청 ID: $REQUEST_ID
결과 목적지: $DESTINATION
상태 파일: /workspace/extra/deploy/status.json

상태 파일을 최대 5분 동안 5초 간격으로 확인한다. request_id가 정확히 "$REQUEST_ID"이고 state가 ok, failed, up-to-date 중 하나일 때만 최종 결과로 취급한다. running과 restarting은 계속 기다린다.

최종 상태가 나오면 send_message를 사용해 "$DESTINATION"에 정확히 한 번 보고한다. ok면 mode와 from→to를 포함해 완료를 알리고, up-to-date면 이미 최신이라고 알린다. failed면 detail을 포함하고 기존 서비스는 구 버전으로 계속 동작한다고 알린다. 5분 안에 최종 상태가 없으면 배포가 계속 진행 중이거나 자동 배포가 응답하지 않아 deploy.log 확인이 필요하다고 알린다. set_status는 결과 전달로 간주하지 않는다.
EOF
)

TASK_RESULT="$(ncl tasks create \
  --name "deploy result" \
  --prompt "$TASK_PROMPT" \
  --process-after "$PROCESS_AFTER" \
  --json)"

printf '%s\n' "$REQUEST_ID" > "$TRIGGER_TMP"
mv "$TRIGGER_TMP" "$DEPLOY_DIR/trigger"

printf 'request_id=%s\n' "$REQUEST_ID"
printf 'notifier=%s\n' "$TASK_RESULT"
