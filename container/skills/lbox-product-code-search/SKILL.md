---
name: lbox-product-code-search
description: LBox 기능의 구현 위치를 찾거나 UI·API 동작, 제품 버그, 환경별 차이, 인증·인가 문제를 FE부터 서버·인프라까지 코드로 추적할 때 사용한다. "이 기능 어디 있어", "왜 이렇게 동작해", "관련 코드 찾아줘" 요청에 사용한다.
---

# LBox 제품 코드 탐색

제품 질문은 코드에서 시작한다. API와 운영 상태는 코드만으로 원인을 좁히기 어려울 때 확인한다.

## 절차

1. `/workspace/extra/lbox-repos`가 없거나 필요한 저장소가 누락됐으면 설치 미완료를 알리고 중단한다. `.aimclaw-sync-status.json`이 `syncing`이면 최대 30초 기다리고 다시 확인하며, `failed`면 현재 checkout으로 분석하되 최신화 실패 사실을 결과에 밝힌다.
2. `/app/skills/lbox-product-code-search/repos.txt`에서 관련 저장소를 고른다. 저장소는 호스트가 주기적으로 갱신하고 컨테이너에는 읽기 전용으로 마운트되므로 `fetch`, `pull`, `checkout`, `reset` 등 Git 상태를 바꾸는 명령은 실행하지 않는다.
3. 선택한 저장소의 `AGENTS.md`와 `CLAUDE.md`를 먼저 읽는다.
4. 제품명, URL, 화면 문구, endpoint, 에러, 이벤트명, env, header를 `rg`로 찾고 다음 흐름을 잇는다.
   - 화면: FE route → page/component → state → API client와 response type
   - API: controller → service/facade → repository/client
   - 환경: ArgoCD/Kustomize/Helm → Istio routing
   - 권한: 서버 web config → IAM/Keycloak → OPA policy
5. 코드로 부족할 때만 필요한 API나 운영 상태를 확인한다. 인증은 OneCLI를 사용하고 credential·쿠키를 출력하거나 영구 저장하지 않는다.
6. 확인한 사실과 추정을 구분해 관련 파일·symbol, 동작 흐름, 원인과 다음 지점을 답한다.

## 저장소 지도

clone 목록의 단일 기준은 `repos.txt`다.

| 저장소 | 확인 범위 |
| --- | --- |
| `lbox-frontend-monorepo` | 제품 화면, 상태, API client, 디자인 시스템, 공통 패키지 |
| `lbox-server` | API와 비즈니스 로직, 데이터·외부 서비스 연동 |
| `lbox-argo-applications` | 환경별 배포, routing, mesh, OPA 런타임 설정 |
| `lbox-iam` | 사용자·권한, Keycloak, admin-api, user-storage |
| `lbox-policy` | 인가 policy, gateway rewrite, service account, header |

FE에서는 `apps/lbox-client`가 LBox 3.0, `apps/lbox-client-nextjs`가 기존 LBox다. LBox 3.0은 `TaskInteraction`과 v3 task/interaction API를 기준으로 추적하고 기존 turn/chat 구조를 대응시키지 않는다.

코드 검색 요청에는 파일과 symbol의 역할을 바로 제시한다. 문제 분석 요청에는 사용자 동작에서 FE·API·서버·인프라로 이어지는 경로와 가능성이 높은 원인을 필요한 만큼만 설명한다.
