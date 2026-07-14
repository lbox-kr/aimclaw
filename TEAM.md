# AimClaw 운영 런북

LBox 팀 공용 Slack 에이전트의 설치, 배포, 갱신과 복구 방법을 정리한다. 개발 원칙은 `AGENTS.md`를 따른다.

## 운영 기준

- 저장소: `lbox-kr/aimclaw`
- 운영 머신: Mac mini 한 대
- 채널: Slack Socket Mode
- 서비스: NanoClaw launchd 서비스
- 배포: `origin/main` 자동 반영

`groups/`, `data/`, `.env`는 운영 머신의 상태이며 Git으로 관리하지 않는다.

## 모델 위임

Claude provider는 기본적으로 Sonnet을 사용한다. 모호하고 고위험인 판단,
아키텍처·보안 결정, 충돌하는 근거 해석, 반복해 실패한 문제는 사용 가능한 경우 최대
effort의 일회성 Opus Task에 위임한다. 명시적인 그룹별 model 설정은 이 기본값보다
우선한다.

## 운영 에이전트

AimClaw의 운영 에이전트는 에이미 하나다. 정체성 원문은
`container/CLAUDE.md`에서 관리한다. 이름, LBox AIM 스쿼드 소속과 서사는 모든
채널에서 동일하며, 그룹 메모리나 사용자에 따라 달라지지 않는다.

`CLAUDE.local.md`는 팀 공유 메모리일 뿐 정체성 원천이 아니다. 이름, 소속, 개인 전용
관계나 별도 페르소나를 기록하지 않는다. 정체성 원문 변경은 자동 배포에서 서비스
재시작 대상으로 처리한다.

```bash
rg -n '^# 에이미|LBox AIM 스쿼드' container/CLAUDE.md
```

마지막으로 실제 Slack 응답에서 정체성이 적용되었는지 확인한다.

## 사용자와 권한

사용자에게는 `관리자`, `일반 사용자` 두 용어만 사용한다. 내부적으로 최초 관리자는
전역 `owner`, 추가 관리자는 전역 `admin`, 일반 사용자는 기존
`agent_group_members`에 저장한다.

### 최초 관리자

Mini 설치 절차에서 전달한 운영자가 기존 첫 에이전트 초기화의 `owner`로 등록된다.

### 관리자 추가·삭제

관리자는 Slack DM이나 봇을 멘션한 채널에서 다음 명령을 사용한다. 호스트가 발신자
ID와 역할 DB를 확인해 직접 처리하며, 마지막 관리자는 자신을 삭제할 수 없다.

```text
관리자 추가 @사용자
관리자 삭제 @사용자

@AimClaw 관리자 추가 @사용자
@AimClaw 관리자 삭제 @사용자
```

### 관리자 작업 승인

호스트 쓰기 작업 중 관리자 승인을 요구하도록 등록된 명령은 현재 요청의 발신자가
관리자이면 승인 카드 없이 실행한다. 일반 사용자이거나 발신자를 확인할 수 없는
요청이 해당 경로에 도달하면 기존 관리자 승인 카드를 사용한다. 발신자 신원과 역할은
모델이나 컨테이너가 전달한 값을 신뢰하지 않고 실행 시점에 호스트에서 확인한다.

### 일반 사용자 등록

Slack 앱이 받은 사람의 DM·멘션은 해당 에이전트의 일반 사용자로 자동 등록한다.
다른 채널의 미등록 사용자 정책은 바뀌지 않는다.

### Slack 채널 연결

에이전트 그룹이 하나이면 새 Slack 그룹 채널의 첫 멘션을 해당 에이전트에 자동으로
연결하고 같은 메시지를 바로 처리한다. 에이전트 그룹이 여러 개이면 연결 대상을
임의로 고르지 않고 기존 관리자 승인 카드를 사용한다. 명시적으로 거절한 채널은
자동으로 다시 연결하지 않는다. 연결된 그룹 채널에서도 에이전트는 매 메시지에
명시적으로 멘션됐을 때만 응답하며, 이미 사용한 thread의 일반 대화를 새 호출로
간주하지 않는다. 필요한 과거 맥락은 실제 호출 후 현재 thread에서 조회한다.

### Slack 처리 상태

Slack thread에서는 네이티브 `Typing...` 상태를 우선 사용한다. 최상위 DM 메시지도
해당 메시지를 root로 하는 Assistant thread에서 답해 타이핑 상태를 표시하지만,
에이전트의 DM 세션과 대화 문맥은 하나로 유지한다. 유효한 thread가 없는 경우에만
`hourglass_flowing_sand` reaction을 사용하고 첫 응답 후 제거한다. 네이티브 상태는
최종 응답·오류·컨테이너 종료 시 명시적으로 해제한다.

### 중단 가능 작업

현재 대화를 넘어가거나 컨테이너·호스트를 중단할 수 있는 작업은 중단 동작보다 먼저
결과 전달을 영속 작업으로 예약한다. 예약에는 Slack destination, 고유 요청 ID와
재개 후 확인할 수 있는 상태 또는 결과 원본을 포함한다. 결과 작업은 같은 요청 ID의
완료나 실패만 한 번 전달한다.

컨테이너 재시작 뒤 같은 작업을 이어야 하면 `ncl groups restart --message`의 on-wake
흐름을 사용한다. 서비스 재시작, 호스트 재시작이나 외부 비동기 작업처럼 별도 결과를
확인해야 하면 세션 DB에 남는 one-shot task를 사용한다. `set_status`는 현재 Slack
대화의 작업 표시일 뿐 이 연속성을 대신하지 않는다. 영속 전달 수단이 없으면 끊긴 뒤
결과를 알려주겠다고 약속하지 않고 다시 확인할 방법을 먼저 안내한다.

### 일반 사용자 화이트리스트

`container/skills/team-user-access/allowlist.json`에서 관리한다.

- `tools`: 일반 대화에서 항상 허용할 가벼운 도구
- `commands`: 허용할 슬래시 커맨드
- `skills`: 스킬 이름과 그 스킬에 필요한 도구 목록. `Skill`을 반드시 포함한다.

```json
{
  "tools": ["WebSearch", "WebFetch"],
  "commands": ["/clear"],
  "skills": {
    "team-search": ["Skill", "WebSearch", "WebFetch"],
    "team-notify": ["Skill", "mcp__nanoclaw__send_*"]
  }
}
```

선택한 허용 스킬의 도구만 현재 요청에 합산된다. 새 사용자의 요청이 오면 합산
상태가 초기화된다. 파일 변경은 다음 요청부터 적용되며, 새 스킬 파일을 추가했다면
그룹 컨테이너를 재시작한다.

## Mini 설치 절차

개발 머신이 아니라 실제 운영할 Mac mini에서 진행한다.

1. 팀 저장소를 clone한다.
   ```bash
   git clone https://github.com/lbox-kr/aimclaw.git
   cd aimclaw
   ```
2. 저장소 루트에서 코딩 에이전트에게 팀 봇 설치를 요청하고 다음 값을 전달한다.
   - Slack Bot User OAuth Token (`xoxb-…`)
   - Slack App-Level Token (`xapp-…`, `connections:write`)
   - 운영자의 Slack member ID
   - 필요한 provider 인증 정보

   운영 에이전트 이름은 에이미를 사용한다.

3. 코딩 에이전트가 `.env` 작성, `bash nanoclaw.sh`, Slack wiring과 응답 확인을 진행한다.
   초기 그룹 메모리에 사용자 전용 봇이나 NanoClaw 정체성이 생성되지 않았는지
   확인한다.
4. GitHub 개인 계정 연결을 완료한 뒤 호스트 저장소 동기화를 설치하고, 읽기 전용 작업공간을 에이전트 그룹에 연결한다.

   ```bash
   mkdir -p ~/nanoclaw-deploy
   bash scripts/team/install-repo-sync.sh

   pnpm exec tsx setup/index.ts --step mounts --force -- --json \
     '{"allowedRoots":[{"path":"~/nanoclaw-deploy","allowReadWrite":true,"description":"team deploy trigger"},{"path":"~/lbox-repos","allowReadWrite":false,"description":"LBox reference repositories"}],"blockedPatterns":[]}'

   # 그룹 id는 ./bin/ncl groups list로 확인한다.
   pnpm exec tsx scripts/q.ts data/v2.db \
     "UPDATE container_configs SET additional_mounts='[{\"hostPath\":\"~/nanoclaw-deploy\",\"containerPath\":\"deploy\",\"readonly\":false},{\"hostPath\":\"~/lbox-repos\",\"containerPath\":\"lbox-repos\",\"readonly\":true}]' WHERE agent_group_id='<id>'"

   ./bin/ncl groups restart --id <id>
   ```

5. 자동 배포 launchd를 설치한다.
   ```bash
   bash scripts/team/install-autodeploy.sh
   ```
6. Slack에서 봇에게 “업데이트해줘”라고 요청해 배포 왕복을 확인한다.

## 배포

- `main`에 push하면 Mac mini가 15분 안에 자동 반영한다.
- 즉시 반영하려면 Slack에서 봇에게 “업데이트해줘”라고 요청한다.
- 하네스만 변경되면 다음 컨테이너 스폰부터 적용된다.
- 즉시 새 하네스가 필요하면 `./bin/ncl groups restart --id <id>`를 실행한다.

배포 상태와 로그는 다음 위치에서 확인한다.

```text
~/nanoclaw-deploy/status.json
~/nanoclaw-deploy/deploy.log
~/nanoclaw-deploy/deployed-sha
```

즉시 배포는 위 중단 가능 작업 계약을 `request_id`와 `status.json`으로 구현한다. 배포
모드와 서비스 재시작 여부에 관계없이 결과 알림 작업을 먼저 예약하고, 같은 요청 ID의
완료 또는 실패를 원래 Slack destination에 한 번 알린다.

`status.json`의 `state`가 `failed`면 기존 프로세스는 계속 실행된다. 실패 원인을
수정하거나 문제 커밋을 revert하면 다음 자동 배포에서 다시 시도한다.

## LBox AWS 정적 파일 배포

이 배포는 위 관리자 작업 승인 정책을 따른다. Slack 메시지에 파일을 첨부하고 배포
대상과 함께 요청하면 봇이 첨부파일을 호스트 전용 staging에 복사해 SHA-256을
확정한다. 이후 Mac mini의 AWS CLI로 백업, 업로드, 원격 검증, CloudFront
invalidation 완료까지 처리한다. AWS credential과 `~/.aws`는 컨테이너에 전달하지
않는다.

현재 지원 profile은 `lbox-system`이다. SSO가 만료됐다는 응답이 오면 Mac mini에서
다음 명령으로 로그인한 뒤 같은 Slack 요청을 다시 실행한다.

```bash
aws sso login --profile lbox-system
```

허용된 배포 경로는 `container/skills/lbox-aws/references/targets.json`에서 관리한다.
`lbox-static-html` target은 `public/lbox/static-html/` 아래의 HTML을 지원하며, 기본
목적지는 첨부파일명이다. 다른 이름으로 배포할 때는 target 범위 안의 상대
`--destination`만 지정한다. 요청 시 만든 staging 사본과 배포 전 백업은 Git에
포함되지 않는 `data/team-lbox-aws/` 아래에 저장한다.

## 코드 참조 저장소

호스트의 `~/lbox-repos`는 AimClaw 코드 분석 전용 checkout이다. launchd가 15분마다
`container/skills/lbox-product-code-search/repos.txt`의 원격 기본 브랜치로 갱신하고,
에이전트 컨테이너에는 `/workspace/extra/lbox-repos`로 읽기 전용 마운트한다. 이
디렉터리의 tracked 파일을 직접 수정하지 않는다. 다음 동기화 때 원격 상태로
되돌아간다.

수동 갱신과 상태 확인은 다음 명령을 사용한다.

```bash
bash scripts/team/sync-repos.sh
cat ~/lbox-repos/.aimclaw-sync-status.json
tail -100 ~/.local/state/aimclaw-repo-sync/sync.log
```

## Upstream 갱신

개발 머신에서 주기적으로 진행하고 Mac mini에서는 직접 갱신하지 않는다.

1. `/update-nanoclaw`을 실행한다.
2. `/update-skills`로 설치된 Slack 코드를 재적용한다.
3. build와 test를 확인한 뒤 `main`에 push한다.
4. 채널과 provider 미러 브랜치를 갱신한다.
   ```bash
   git fetch upstream channels providers
   git push --force origin \
     refs/remotes/upstream/channels:refs/heads/channels \
     refs/remotes/upstream/providers:refs/heads/providers
   ```

`README.md` 충돌은 AimClaw 버전을 유지한다. upstream 갱신의 나머지 안전 절차와
롤백 태그는 `/update-nanoclaw` 안내를 따른다.

## 롤백

- 일반 변경은 `git revert <commit>` 후 `main`에 push한다.
- upstream 갱신은 `/update-nanoclaw`이 만든 `pre-update-*` 태그로 개발 머신을
  되돌린 뒤 push한다.
- 자동 배포가 베이스 이미지를 갱신해도 `install_packages`를 사용한 파생 이미지는
  자동으로 바뀌지 않는다. 필요하면 다음을 실행한다.
  ```bash
  ./bin/ncl groups restart --id <id> --rebuild
  ```

## 장애 확인

다음 순서로 확인한다.

1. `logs/nanoclaw.error.log`
2. `logs/nanoclaw.log`
3. `logs/setup.log`과 `logs/setup-steps/`
4. `data/v2-sessions/<agent-group>/<session>/inbound.db`
5. `data/v2-sessions/<agent-group>/<session>/outbound.db`

DB를 직접 조회할 때는 `sqlite3` 대신 저장소의 wrapper를 사용한다.

```bash
pnpm exec tsx scripts/q.ts <db> "<sql>"
```
