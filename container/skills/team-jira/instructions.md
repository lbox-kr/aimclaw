# 일감 · Jira

"일감", "티켓", "내 이슈", "할 일", "지라", "스프린트" 같은 업무 항목 요청은 Jira를 뜻한다. `team-jira` 스킬을 써서 외부 Atlassian MCP 도구로만 `lbox.atlassian.net`을 다룬다.

철칙: Jira REST API를 `curl`, `fetch`, 브라우저로 직접 호출하거나 OneCLI credential로 우회하지 않는다. Atlassian MCP 도구가 없거나 인증이 필요하면 호스트에서 Jira 로그인을 완료한 뒤 다시 요청해 달라고 알리고 중단한다. "내 일감"은 MCP에 연결된 Jira 실행 계정에 할당된 일감을 뜻한다.
