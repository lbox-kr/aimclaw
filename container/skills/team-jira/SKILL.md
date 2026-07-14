---
name: team-jira
description: 팀 일감(Jira 이슈)을 Atlassian MCP로 조회·검색·생성·코멘트한다. 사용자가 "일감", "내 티켓", "할당된 이슈", "지라", "스프린트", "뭐 해야 하지", "할 일 뭐 있어", "이 이슈 상태" 처럼 업무 항목을 묻거나 다루라고 하면 이 스킬을 사용한다. 코드가 어디에 있는지 추적하는 요청에는 lbox-product-code-search를 쓴다.
---

# Team Jira — 일감 조회·관리

LBox 팀의 일감은 Jira(`https://lbox.atlassian.net`, 주 프로젝트 키 `AIM`)에 있다. Jira는 **Atlassian MCP 도구로만** 다룬다. 인증과 권한은 외부 MCP 호스트에 연결된 Jira 실행 계정이 소유한다.

## 철칙

- 우선 Atlassian MCP 도구를 찾고 실제 호출해 결과로 답한다. 도구가 지연 로드되면 `ToolSearch`에서 `atlassian`, `jira`로 찾는다.
- Jira REST API를 `curl`, `fetch`, 브라우저나 일반 HTTP 클라이언트로 직접 호출하지 않는다.
- Jira에 OneCLI credential 주입, OneCLI 대시보드 연결이나 컨테이너 내 로그인을 시도하지 않는다.
- MCP 도구가 없거나 인증이 필요하면 "호스트에서 Jira 로그인을 완료한 뒤 다시 요청해 달라"고 알리고 중단한다. REST나 OneCLI로 우회하지 않는다.
- 연결된 Jira 실행 계정을 권한 주체로 간주한다. "내 일감"은 이 계정에 할당된 일감을 뜻한다.

## MCP 도구 선택

서버 namespace와 표시 이름은 호스트 설정에 따라 다를 수 있다. 도구의 실제 스키마를 확인하고 아래 의도에 맞는 Atlassian MCP 도구를 사용한다.

- 연결 정보: `getAccessibleAtlassianResources`, `atlassianUserInfo`
- JQL 검색: `searchJiraIssuesUsingJql`
- 이슈 상세: `getJiraIssue`
- 프로젝트·사용자 탐색: `getVisibleJiraProjects`, `lookupJiraAccountId`
- 이슈 작성: `createJiraIssue`, `addCommentToJiraIssue`, `editJiraIssue`, `transitionJiraIssue`

처음 호출하는 사이트라면 `getAccessibleAtlassianResources`로 `lbox.atlassian.net`의 `cloudId`를 확인한 뒤 후속 Jira 도구에 넘긴다.

## 조회 (검색)

- `searchJiraIssuesUsingJql`에 JQL과 필요한 field, 결과 수를 넘긴다. 페이지네이션은 MCP 도구 응답과 스키마를 따른다.
- 자주 쓰는 JQL:
  - 내 전체 일감: `assignee = currentUser() ORDER BY updated DESC`
  - 진행 중만: `assignee = currentUser() AND status = "진행 중"`
  - 특정 프로젝트: `project = AIM AND statusCategory != Done ORDER BY updated DESC`
  - 이번 스프린트 내 것: `assignee = currentUser() AND sprint in openSprints()`
- 담당자를 특정 사람으로 지정하려면 `lookupJiraAccountId`로 `accountId`를 찾아 JQL에 사용한다.

## 이슈 상세

`getJiraIssue`에 `cloudId`, 이슈 키와 필요한 field를 넘긴다.

## 이슈 생성 / 코멘트

MCP 도구가 요구하는 스키마로 본문을 구성한다. 이슈를 생성·수정·전환하는 건 되돌리기 어려운 작업이니, 대상·변경 내용을 사용자에게 한 번 확인한 뒤 MCP 작성 도구를 호출한다.

## Slack에 보여주기

목록은 길게 늘어놓지 말고 한 줄씩 간결하게. 각 항목은 `[키] 요약 — 상태` 형태로, 키는 링크로 건다.

```
<https://lbox.atlassian.net/browse/AIM-4477|AIM-4477> [FE] 직업인증 OCR PDF 입력 지원 — 진행 중
```

항목이 많으면 상위 몇 개만 보여주고 "더 볼까요?"로 확장한다. 상태·수치가 핵심이면 slack-formatting 스킬의 카드/필드를 활용한다.
