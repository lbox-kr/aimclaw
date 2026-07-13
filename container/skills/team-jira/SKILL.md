---
name: team-jira
description: 팀 일감(Jira 이슈)을 조회·검색·생성·코멘트한다. 사용자가 "일감", "내 티켓", "할당된 이슈", "지라", "스프린트", "뭐 해야 하지", "할 일 뭐 있어", "이 이슈 상태" 처럼 업무 항목을 묻거나 다루라고 하면 이 스킬을 사용한다. Jira는 lbox.atlassian.net이고 OneCLI 게이트웨이가 인증을 자동 주입한다. 코드가 어디에 있는지 추적하는 요청에는 lbox-product-code-search를 쓴다.
---

# Team Jira — 일감 조회·관리

LBox 팀의 일감은 Jira(`https://lbox.atlassian.net`, 주 프로젝트 키 `AIM`)에 있다. 너의 HTTP 요청은 OneCLI 게이트웨이를 거치며 인증이 자동 주입되므로 **그냥 `curl`로 실제 API를 호출**하면 된다. 토큰을 묻거나 다루지 않는다.

## 철칙

- "일감/티켓/지라"를 묻는데 **연결 상태를 추측하지 않는다.** 먼저 아래 호출을 실제로 실행하고 그 결과로 답한다.
- 응답이 `401`/`403`/`app_not_connected`이면 본문의 `connect_url`을 각괄호·마크다운 없이 한 줄로 안내한다. 그런 필드가 없으면 사용자에게 OneCLI 대시보드에서 Jira를 연결하라고 안내한다.
- 그 외 에러(400 등)는 JQL이나 파라미터 문제일 수 있으니 메시지를 읽고 고쳐 재시도한다.

## 조회 (검색)

엔드포인트는 **`/rest/api/3/search/jql`** 이다. 구 `/rest/api/3/search`는 삭제되어 `410`을 반환하니 쓰지 않는다.

```bash
# 내 미완료 일감 (가장 흔한 요청: "내 일감", "할 일")
curl -sS "https://lbox.atlassian.net/rest/api/3/search/jql" \
  --data-urlencode 'jql=assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC' \
  --data-urlencode 'maxResults=20' \
  --data-urlencode 'fields=summary,status,priority,updated' -G
```

- 페이지네이션은 응답의 `nextPageToken`을 `&nextPageToken=...`로 넘겨 이어 받는다. `isLast=true`면 끝이다.
- 자주 쓰는 JQL:
  - 내 전체 일감: `assignee = currentUser() ORDER BY updated DESC`
  - 진행 중만: `assignee = currentUser() AND status = "진행 중"`
  - 특정 프로젝트: `project = AIM AND statusCategory != Done ORDER BY updated DESC`
  - 이번 스프린트 내 것: `assignee = currentUser() AND sprint in openSprints()`
- 담당자를 특정 사람으로 지정하려면 먼저 `GET /rest/api/3/user/search?query=<이름/이메일>`로 `accountId`를 찾아 `assignee = "<accountId>"`로 건다.

## 이슈 상세

```bash
curl -sS "https://lbox.atlassian.net/rest/api/3/issue/AIM-1234?fields=summary,status,assignee,priority,description,updated"
```

## 이슈 생성 / 코멘트

`description`과 코멘트 본문은 Atlassian Document Format(ADF, JSON)이어야 한다.

```bash
# 생성
curl -sS -X POST "https://lbox.atlassian.net/rest/api/3/issue" \
  -H 'Content-Type: application/json' -d '{
  "fields": {
    "project": { "key": "AIM" },
    "issuetype": { "name": "Task" },
    "summary": "요약",
    "description": { "type":"doc","version":1,"content":[
      {"type":"paragraph","content":[{"type":"text","text":"본문"}]} ] }
  }
}'

# 코멘트
curl -sS -X POST "https://lbox.atlassian.net/rest/api/3/issue/AIM-1234/comment" \
  -H 'Content-Type: application/json' -d '{
  "body": { "type":"doc","version":1,"content":[
    {"type":"paragraph","content":[{"type":"text","text":"코멘트 내용"}]} ] }
}'
```

이슈를 생성·수정하는 건 되돌리기 어려운 작업이니, 요약/프로젝트/타입을 사용자에게 한 번 확인한 뒤 실행한다.

## Slack에 보여주기

목록은 길게 늘어놓지 말고 한 줄씩 간결하게. 각 항목은 `[키] 요약 — 상태` 형태로, 키는 링크로 건다.

```
<https://lbox.atlassian.net/browse/AIM-4477|AIM-4477> [FE] 직업인증 OCR PDF 입력 지원 — 진행 중
```

항목이 많으면 상위 몇 개만 보여주고 "더 볼까요?"로 확장한다. 상태·수치가 핵심이면 slack-formatting 스킬의 카드/필드를 활용한다.
