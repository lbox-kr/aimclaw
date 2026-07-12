# TEAM.md — lbox 팀 봇 운영 규약

팀 공용 NanoClaw 슬랙 봇 포크(`lbox-kr/aimclaw`)의 운영 문서. upstream은
[qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw). 신뢰 기반 운영 —
브랜치 보호·필수 리뷰 없음, 전원 main 직접 push.

## 두 층 규약

기능 추가의 **기본 착지점은 하네스 층**이다. 코드는 꼭 필요할 때만 건드린다.

**하네스 층** (git 추적, 재시작 불필요 — 다음 컨테이너 스폰부터 반영):

| 위치 | 용도 |
|---|---|
| `container/CLAUDE.md` | 전 에이전트 공유 전역 규칙 |
| `container/skills/<name>/SKILL.md` | 스킬 — 전 세션에 자동 노출. `instructions.md`를 함께 두면 시스템 프롬프트에 자동 포함 |
| `templates/<name>/` | 새 에이전트 페르소나 (`context/instructions.md` 필수) |

즉시 적용이 필요하면 mini에서 `./bin/ncl groups restart --id <id>`.

**코드 층**: `src/custom/`에 신규 파일을 additive하게 추가하고
`src/custom/index.ts`에서 import한다. upstream 파일 직접 수정은 최소화
(docs/customizing.md의 스킬 철학과 동일 — upstream과의 접점이 작을수록
`/update-nanoclaw` 머지가 편하다).

`groups/`·`data/`의 파일(CLAUDE.local.md 등)은 봇의 개인 메모리·머신 상태다.
git으로 관리하지 않는다.

## 기여 흐름

```
clone → 수정 → pnpm run build && pnpm test → main push
```

- 하네스 변경은 push만으로 끝 — mini가 15분 내 자동 반영, 슬랙에서 봇에게
  "업데이트해줘"라고 하면 즉시.
- **커밋 금지**: `.env*`(example 제외), `data/`, `store/`, `logs/`, `groups/`,
  `*.keys.json`, `.claude/settings.json`의 로컬 변형, `versions.json` 임의 수정.

## upstream 동기화

담당자가 **주 1회** 개발 맥 clone에서 Claude Code로 `/update-nanoclaw` 실행.
대화형(충돌 해결·breaking 체크·검증 포함)이라 무인 스케줄에는 부적합하다.

1. `/update-nanoclaw` — upstream URL 질문에는 `https://github.com/qwibitai/nanoclaw.git`
2. 이어서 `/update-skills`로 설치된 채널(slack) 재적용
3. main push + 미러 브랜치 갱신:
   ```bash
   git fetch upstream channels providers && \
   git push --force origin refs/remotes/upstream/channels:refs/heads/channels \
     refs/remotes/upstream/providers:refs/heads/providers
   ```

주의: v1↔v2 경계는 머지 금지(CLAUDE.md 상단 배너). 드리프트가 크면
`/migrate-nanoclaw` 고려. **mini에는 아무 것도 하지 않는다** — push만 하면
자동 배포가 마커 스탬프(`scripts/upgrade-state.ts set`)까지 처리한다.

## mini 설치 절차

1. 팀 포크 clone → `.env` 작성(`.env.example` 참고). Slack 토큰 발급:
   api.slack.com/apps → Socket Mode 활성화 → App-Level Token
   (`connections:write`) = `SLACK_APP_TOKEN`, OAuth Bot Token =
   `SLACK_BOT_TOKEN`. 스코프는 `.claude/skills/add-slack/SKILL.md` 참고.
2. `bash nanoclaw.sh` — Node/pnpm/Docker/OneCLI/컨테이너 빌드/서비스 등록까지
   공식 플로우. 첫 채널 선택에서 Slack.
3. Claude Code에서 `/manage-channels`로 팀 슬랙 채널 ↔ 에이전트 그룹 wiring.
4. 배포 마운트 — allowlist 등록 후 그룹에 마운트:
   ```bash
   pnpm exec tsx setup/index.ts --step mounts --force -- --json \
     '{"allowedRoots":[{"path":"~/nanoclaw-deploy","allowReadWrite":true,"description":"team deploy trigger"}],"blockedPatterns":[]}'
   # 그룹 id는 ./bin/ncl groups list 로 확인
   pnpm exec tsx scripts/q.ts data/v2.db \
     "UPDATE container_configs SET additional_mounts='[{\"hostPath\":\"~/nanoclaw-deploy\",\"containerPath\":\"deploy\",\"readonly\":false}]' WHERE agent_group_id='<id>'"
   ```
5. `bash scripts/team/install-autodeploy.sh` — 자동 배포 launchd 등록 (mini 전용).
6. 슬랙에서 봇에게 "업데이트해줘"로 왕복 확인.

## 갱신·롤백

- **평시 갱신**: main push(15분 주기 자동) 또는 슬랙에서 "업데이트해줘"(즉시).
- **롤백 표준**: `git revert` 후 push — 자동 배포가 알아서 적용한다.
- **배포 실패 시**(`~/nanoclaw-deploy/status.json`이 `state=failed`): 실행
  중인 프로세스는 건드리지 않으므로 서비스는 구 버전으로 계속 동작하고,
  자동 배포가 15분 주기·슬랙 트리거마다 같은 대상을 재시도한다(일시적
  오류는 자연 회복). 단, 의존성 변경이 포함된 커밋의 빌드 실패는
  node_modules가 이미 새 버전으로 바뀐 상태라 프로세스가 죽거나 mini가
  재부팅되면 문제가 될 수 있다 — failed를 보면 미루지 말고 revert push.
- **이미지 변경 주의**: 자동 배포는 베이스 이미지만 리빌드한다.
  `install_packages`로 파생 이미지를 가진 그룹은 mini에서
  `./bin/ncl groups restart --id <id> --rebuild`로 개별 리빌드해야 새
  베이스가 반영된다.
- **upstream 업데이트 롤백**: `/update-nanoclaw`가 출력한 `pre-update-*`
  태그로 `git reset --hard`(개발 맥) 후 force push — mini의 자동 배포는
  origin/main이 뒤로 간 것을 감지하면 따라간다.
