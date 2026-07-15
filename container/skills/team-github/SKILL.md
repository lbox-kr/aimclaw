---
name: team-github
description: LBox GitHub 저장소의 PR·이슈·checks를 조회하고, 이슈를 생성하거나 PR·이슈에 코멘트한다. 사용자가 GitHub, PR, 풀 리퀘스트, 코드 리뷰 상태, CI checks, GitHub 이슈를 묻거나 다루라고 하면 사용한다.
allowed-tools: Bash(ncl github:*)
---

# Team GitHub

LBox GitHub 작업은 Mac 호스트에 로그인된 `gh` 계정으로 실행한다. 컨테이너에서
`gh`, GitHub REST API, OneCLI credential을 직접 사용하지 않고 반드시 아래 `ncl`
명령만 사용한다.

현재 외부 서비스 도구 정책에 따라 이 스킬은 관리자만 사용할 수 있다. 일반 사용자
권한을 넓히기 위해 `Bash`를 허용 목록에 추가하지 않는다. 일반 사용자용 GitHub 접근은
별도의 구조화된 도구 경계가 마련된 뒤 지원한다.

허용 저장소는 `/app/skills/lbox-product-code-search/repos.txt`에 등록된
`lbox-kr/<repo>`로 제한된다. 코드 구현을 찾는 요청은 `lbox-product-code-search`로
읽기 전용 checkout을 조사하고, PR·이슈·checks의 현재 상태는 이 스킬로 조회한다.

## 조회

```bash
ncl github pr list --repo lbox-kr/<repo> [--state open|closed|merged|all] [--limit 30] [--search <query>]
ncl github pr view <number> --repo lbox-kr/<repo>
ncl github pr checks <number> --repo lbox-kr/<repo>
ncl github issue list --repo lbox-kr/<repo> [--state open|closed|all] [--limit 30] [--search <query>]
ncl github issue view <number> --repo lbox-kr/<repo>
```

목록에서 사용자가 말한 저장소나 번호를 추측하지 않는다. 저장소가 불분명하면
`repos.txt`의 후보를 좁히고, 그래도 하나로 확정되지 않을 때만 묻는다.

## 쓰기

지원하는 쓰기는 이슈 생성과 새 코멘트뿐이다.

```bash
ncl github issue create --repo lbox-kr/<repo> --title <title> --body <body>
ncl github pr comment <number> --repo lbox-kr/<repo> --body <body>
ncl github issue comment <number> --repo lbox-kr/<repo> --body <body>
```

대상 저장소·번호와 작성할 내용을 사용자 요청에서 확정한 뒤 실행한다. merge, close,
reopen, approve, request-changes, workflow 실행, release, repository 설정과 secret 변경은
지원하지 않는다. 임의 `gh api`나 다른 호스트 명령으로 우회하지 않는다.

명령이 승인 대기를 반환하면 승인 대기 중이라고 답하고, 승인 완료 시스템 메시지보다
먼저 성공했다고 말하지 않는다. 성공하면 반환된 GitHub URL을 함께 보여준다.

## 오류

- `GITHUB_HOST_LOGIN_REQUIRED`이면 Mac 호스트에서 `gh auth login --hostname github.com`을
  완료한 뒤 다시 요청해 달라고 알린다.
- 저장소가 허용 목록에 없으면 다른 API나 credential로 우회하지 않는다.
- 권한 오류는 호스트 `gh` 실행 계정의 GitHub 저장소 권한 문제로 설명한다.
