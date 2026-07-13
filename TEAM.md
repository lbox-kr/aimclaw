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

Claude provider의 기본 모델은 `claude-haiku-4-5-20251001`이다. Haiku는 대상과
절차가 사용자 요청이나 기존 스킬에 완전히 정의된 작업을 실행한다. 범위, 증거,
방법, 기준, 결론을 새로 정해야 하는 작업은 일회성 Task로 Opus에 위임한다. 세부
경계는 `container/CLAUDE.md`에서 관리하며 명시적인 그룹별 model 설정이 기본값보다
우선한다.

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

### 일반 사용자 등록

Slack 앱이 받은 사람의 DM·멘션은 해당 에이전트의 일반 사용자로 자동 등록한다.
다른 채널의 미등록 사용자 정책은 바뀌지 않는다.

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
   - 에이전트 이름과 필요한 provider 인증 정보
3. 코딩 에이전트가 `.env` 작성, `bash nanoclaw.sh`, Slack wiring과 응답 확인을 진행한다.
4. GitHub 개인 계정 연결을 완료한 뒤 LBox 저장소를 clone하고 작업공간을 에이전트 그룹에 연결한다.

   ```bash
   mkdir -p ~/nanoclaw-deploy ~/lbox-repos

   while read -r name url; do
     target="$HOME/lbox-repos/$name"
     if [ -d "$target/.git" ]; then
       git -C "$target" fetch --all --prune
     else
       git clone --filter=blob:none "$url" "$target"
     fi
   done < container/skills/lbox-product-code-search/repos.txt

   pnpm exec tsx setup/index.ts --step mounts --force -- --json \
     '{"allowedRoots":[{"path":"~/nanoclaw-deploy","allowReadWrite":true,"description":"team deploy trigger"},{"path":"~/lbox-repos","allowReadWrite":true,"description":"LBox reference repositories"}],"blockedPatterns":[]}'

   # 그룹 id는 ./bin/ncl groups list로 확인한다.
   pnpm exec tsx scripts/q.ts data/v2.db \
     "UPDATE container_configs SET additional_mounts='[{\"hostPath\":\"~/nanoclaw-deploy\",\"containerPath\":\"deploy\",\"readonly\":false},{\"hostPath\":\"~/lbox-repos\",\"containerPath\":\"lbox-repos\",\"readonly\":false}]' WHERE agent_group_id='<id>'"

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

`status.json`의 `state`가 `failed`면 기존 프로세스는 계속 실행된다. 실패 원인을
수정하거나 문제 커밋을 revert하면 다음 자동 배포에서 다시 시도한다.

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
