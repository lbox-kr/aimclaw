---
name: team-update
description: 봇 자체를 최신 코드로 갱신(배포)한다. 사용자가 "업데이트해줘", "갱신해줘", "배포해줘" 등 봇의 코드/설정을 최신으로 만들라고 요청하면 이 스킬을 사용한다. 일반적인 소프트웨어 업데이트 질문에는 사용하지 않는다.
---

# Team Update — 봇 갱신 트리거

팀 포크(main)에 push된 변경을 mini 호스트에 즉시 반영시키는 스킬. 실제 배포는 호스트의 자동 배포 데몬(launchd)이 수행하며, 너는 트리거 파일을 건드리고 결과를 보고할 뿐이다.

## 절차

1. **마운트 확인**: `/workspace/extra/deploy/` 디렉토리가 존재하는지 확인한다.
   - 없으면: "이 그룹에는 배포 마운트가 없습니다. TEAM.md의 mini 설치 절차(배포 마운트 설정)를 참고하세요."라고 답하고 **중단**한다.
2. **목적지 확인**: 현재 입력의 `<message from="...">`에 있는 destination 이름을 사용한다. 입력에 `from`이 없고 destination이 하나뿐이면 그 이름을 사용한다. 추측할 수 없으면 사용자에게 결과를 보낼 곳을 확인하고 중단한다.
3. **사전 안내**: `send_message`로 먼저 답한다 — "갱신을 시작할게요. 현재 대화가 중간에 끊겨도 완료 결과는 이어서 알려드릴게요."
4. **알림 예약 + 트리거**: 다음 스크립트를 목적지 이름과 함께 한 번 실행한다. 스크립트는 요청 ID가 일치하는 결과만 보고하는 one-shot task를 먼저 만든 뒤 trigger를 원자적으로 갱신한다.
   ```bash
   /app/skills/team-update/scripts/request-update.sh '<destination>'
   ```
   성공하면 현재 turn에서 `status.json`을 폴링하지 않는다. 결과 알림 task가 완료·실패·이미 최신 상태를 한 번 보고한다. 별도의 최종 메시지를 중복으로 보내지 말고 turn을 끝낸다.
   실패하면 trigger가 작성되지 않았을 수 있으므로 오류를 사용자에게 바로 알린다.
5. **결과 해석**: 알림 task는 `/workspace/extra/deploy/status.json`에서 자신의 `request_id`와 일치하는 최종 상태를 기다린다:
   - `state`: `ok`(성공) / `failed`(실패) / `up-to-date`(이미 최신)
   - `from` → `to`: 배포 전후 커밋
   - `mode`: `harness`(문서·스킬만, 재시작 없음) / `code`(빌드+서비스 재시작)
   - `failed`면 `detail`을 함께 전하고, git revert 후 push로 복구할 수 있다고 안내한다. 서비스는 구 버전으로 계속 동작 중이고, 자동 배포가 15분 주기로 같은 대상을 재시도하므로 일시적 오류라면 다음 주기에 자연 회복될 수 있다.
   - 5분 안에 최종 상태가 나오지 않으면 배포가 계속 진행 중이거나 자동 배포가 응답하지 않는다고 알리고, `deploy.log` 확인이 필요하다고 안내한다.

`set_status`는 현재 대화의 일시적인 작업 표시이며 대화·컨테이너·호스트 중단을 넘기는 상태 저장소가 아니다. 이 스킬에서는 알림 task를 대체하는 용도로 사용하지 않는다.

## status.json 형식

```json
{
  "request_id": "<요청 ID>",
  "state": "running | restarting | ok | failed | up-to-date",
  "mode": "harness | code",
  "from": "<이전 커밋 sha>",
  "to": "<새 커밋 sha>",
  "at": "<ISO 타임스탬프>",
  "detail": "<추가 설명 또는 실패 원인>"
}
```
