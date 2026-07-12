# AimClaw 개발 계약

이 문서는 AimClaw에서 작업하는 코딩 에이전트가 따라야 할 팀 지침이다. 작업을
시작하기 전에 `CLAUDE.md`를 완전히 읽어 NanoClaw의 아키텍처와 안전 규칙을
확인한다. 서로 충돌하지 않는 범위에서 이 문서의 제품 결정과 작업 우선순위를 먼저
적용한다.

## 목표

AimClaw은 LBox 팀이 Slack에서 함께 사용하는 AI 에이전트다. 한 대의 Mac mini에서
안정적으로 운영하면서, 팀이 자연어로 기능을 요청하고 빠르게 개선할 수 있어야 한다.

## 확정된 결정

- NanoClaw v2만을 기반으로 한다.
- 기본 채널은 Slack Socket Mode다.
- 운영 인스턴스는 Mac mini 한 대다.
- 사용자 응답과 팀 하네스는 한국어를 기본으로 한다.
- 범용성보다 현재 팀의 DX, 단순성, 실제 사용성을 우선한다.
- 새 설정 체계나 추상화는 반복되는 필요가 확인된 뒤 도입한다.

## 구현 우선순위

기존 구현을 먼저 조사하고 다음 순서로 해결한다.

1. NanoClaw 내장 기능과 기존 스킬을 재사용한다.
2. `container/CLAUDE.md`의 전역 지침으로 해결한다.
3. `container/skills/<name>/`에 런타임 스킬을 추가하거나 개선한다.
4. 새 에이전트 유형이면 `templates/`를 사용한다.
5. 코드가 필요하면 새 파일을 `src/custom/`에 additive하게 추가한다.
6. 위 방식으로 해결할 수 없을 때만 upstream 코어를 최소 범위로 수정한다.

불필요한 wrapper, 별도 동기화 계층, 하위 upstream 저장소, 설정 복제는 만들지 않는다.

## 설치 요청 처리

사용자가 환경값이나 Slack 정보를 전달하며 설치를 요청하면 문서만 안내하지 말고
설치를 끝까지 진행한다.

- 필요한 값만 추가로 묻는다.
- 전달받은 비밀값은 출력하거나 문서화하지 않는다.
- Slack 환경값은 `.env`에 저장하고 provider credential은 기존 setup과 OneCLI를 통해 등록한다.
- Slack은 `SLACK_BOT_TOKEN`과 `SLACK_APP_TOKEN`을 사용하는 Socket Mode를 기본으로 한다.
- 한국어 렌더링을 위해 `INSTALL_CJK_FONTS=true`, `TZ=Asia/Seoul`을 기본으로 사용한다.
- `bash nanoclaw.sh`와 기존 Slack setup 흐름을 재사용한다.
- 에이전트 wiring, 자동 배포, 서비스 상태와 실제 Slack 응답까지 확인한다.
- 원시 credential, `.env`, `data/`, `groups/`를 Git에 포함하지 않는다.

## 문서 책임

- `README.md`: GitHub 첫 화면과 프로젝트 소개. AimClaw 소유이며 upstream 충돌 시 이 저장소의 버전을 유지한다.
- `AGENTS.md`: 제품 결정과 개발 계약. AimClaw 소유다.
- `TEAM.md`: 설치와 운영 런북. 현재 운영 방법만 기록한다.
- `CLAUDE.md`와 `docs/`: upstream 아키텍처와 안전 지침. 필요한 연결 문구 외에는 가능한 한 그대로 유지한다.

팀 문서는 현재 해야 할 일만 설명한다. 구축 이력, 폐기된 선택지, 사용하지 않는
마이그레이션 설명을 추가하지 않는다.

## 변경과 검증

- 작업 전 관련 코드와 기존 기능을 확인한다.
- 변경 범위를 요청에 필요한 최소 단위로 유지한다.
- 하네스 변경은 관련 문서와 스킬 참조를 확인한다.
- 런타임 코드 변경은 `pnpm run build`와 관련 테스트를 실행한다.
- `container/agent-runner/src/`를 수정하면 별도 container typecheck와 Bun 테스트 규칙을 따른다.
- push 전 `git status`와 diff를 확인해 설치별 파일이 포함되지 않았는지 검증한다.
- main 직접 반영은 허용하지만 commit이나 push는 사용자가 요청한 범위에서만 수행한다.

## Git과 upstream

- upstream 갱신은 일반 `git pull`이 아니라 `/update-nanoclaw`을 사용한다.
- 설치된 Slack 채널 코드는 갱신 후 `/update-skills`로 재적용한다.
- 팀 확장은 `src/custom/`, `scripts/team/`, `container/skills/team-*`처럼 소유권이 명확한 위치에 둔다.
- `package.json`, lockfile, barrel import 등 공동 접점은 필요한 최소 변경만 유지한다.
- 실제 값이 있는 `.env` 계열 파일, `data/`, `store/`, `logs/`, `groups/`,
  `*.keys.json`, 로컬 `.claude/settings.json`, 임의의 `versions.json` 변경은 커밋하지
  않는다.
