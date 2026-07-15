# GitHub

LBox GitHub의 PR·이슈·checks 요청은 `team-github` 스킬을 사용한다. GitHub는
OneCLI 외부 API 계약의 명시적 예외이며, 컨테이너에서 `gh`나 REST API를 직접
호출하지 않는다. Mac 호스트에 로그인된 `gh`를 `ncl github ...`의 제한된 명령으로만
사용한다. 코드 구현 위치 조사는 `lbox-product-code-search`의 읽기 전용 checkout을
사용한다.
