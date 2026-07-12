# AimClaw 운영 런북

LBox 팀 공용 Slack 에이전트의 설치, 배포, 갱신과 복구 방법을 정리한다. 개발 원칙은 `AGENTS.md`를 따른다.

## 운영 기준

- 저장소: `lbox-kr/aimclaw`
- 운영 머신: Mac mini 한 대
- 채널: Slack Socket Mode
- 서비스: NanoClaw launchd 서비스
- 배포: `origin/main` 자동 반영

`groups/`, `data/`, `.env`는 운영 머신의 상태이며 Git으로 관리하지 않는다.

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
4. 배포 디렉터리를 allowlist와 에이전트 그룹에 연결한다.
   ```bash
   pnpm exec tsx setup/index.ts --step mounts --force -- --json \
     '{"allowedRoots":[{"path":"~/nanoclaw-deploy","allowReadWrite":true,"description":"team deploy trigger"}],"blockedPatterns":[]}'

   # 그룹 id는 ./bin/ncl groups list로 확인한다.
   pnpm exec tsx scripts/q.ts data/v2.db \
     "UPDATE container_configs SET additional_mounts='[{\"hostPath\":\"~/nanoclaw-deploy\",\"containerPath\":\"deploy\",\"readonly\":false}]' WHERE agent_group_id='<id>'"
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
