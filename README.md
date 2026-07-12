# AimClaw

LBox 팀이 Slack에서 함께 사용하는 AI 에이전트입니다.
[NanoClaw v2](https://github.com/qwibitai/nanoclaw)를 기반으로 한 대의 Mac mini에서
단순하게 운영하고, 대화로 빠르게 개선하는 것을 목표로 합니다.

## 목표

- Slack을 팀의 기본 AI 인터페이스로 사용합니다.
- 한국어와 팀의 실제 업무 흐름을 우선합니다.
- 범용성보다 단순한 운영과 좋은 개발 경험을 중시합니다.
- 코딩 에이전트와 대화하며 필요한 기능을 점진적으로 추가합니다.

## Philosophy

- **기존 기능 우선**: NanoClaw에 있는 기능은 다시 만들지 않습니다.
- **하네스 우선**: 전역 지침, 스킬, 템플릿으로 해결하고 코드는 필요할 때만 수정합니다.
- **작은 변경**: 새 계층이나 추상화보다 지금 필요한 가장 작은 구현을 선택합니다.
- **업스트림 보호**: 팀 코드는 additive하게 두고 NanoClaw 코어 수정은 최소화합니다.

## 시작하기

```bash
git clone https://github.com/lbox-kr/aimclaw.git
cd aimclaw
```

저장소 루트에서 코딩 에이전트를 열고 다음처럼 요청합니다.

> 팀 봇을 설치해줘. 필요한 Slack 정보와 환경값은 내가 전달할게.

에이전트는 Slack 환경값을 `.env`에 저장하고 provider credential은 기존 setup과
OneCLI를 통해 등록합니다. 이어서 `bash nanoclaw.sh`를 실행해 Slack 연결, 에이전트
wiring, 서비스 설치와 동작 확인을 진행합니다. 비밀값은 출력하거나 Git에 커밋하지
않습니다.

직접 공식 설치 화면을 진행하려면 다음 명령을 실행하고 첫 채널로 Slack을 선택합니다.

```bash
bash nanoclaw.sh
```

## 개발하기

기능 설명, 불편한 점, 원하는 동작을 자연어로 요청하면 됩니다. 코딩 에이전트는
[AGENTS.md](AGENTS.md)의 제품 결정과 개발 원칙을 먼저 따릅니다.

```text
슬랙에서 이 요청을 처리할 수 있게 개선해줘.
이 반복 작업을 팀 스킬로 만들어줘.
업스트림 기능을 재사용할 수 있는지 먼저 확인해줘.
```

변경은 관련 검증을 통과한 뒤 `main`에 반영합니다. 런타임 코드를 수정했다면 기본
검증은 다음과 같습니다.

```bash
pnpm run build
pnpm test
```

## 문서

- [AGENTS.md](AGENTS.md): 제품 결정과 바이브코딩 개발 계약
- [TEAM.md](TEAM.md): Mac mini 설치, 배포, 갱신, 롤백과 장애 확인
- [docs/architecture.md](docs/architecture.md): NanoClaw 런타임 아키텍처
- [upstream NanoClaw](https://github.com/qwibitai/nanoclaw): 원본 프로젝트와 범용 문서

## Upstream

`README.md`, `AGENTS.md`, `TEAM.md`는 AimClaw이 소유합니다. upstream 갱신에는
`/update-nanoclaw`을 사용하고, `README.md` 충돌은 이 저장소의 내용을 유지합니다.
NanoClaw 내부 문서와 마이그레이션 자산은 사용 여부와 관계없이 가능한 한 그대로
보존합니다.
