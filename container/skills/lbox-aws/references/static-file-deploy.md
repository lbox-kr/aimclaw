# 정적 파일 배포

## Preset 배포

1. 현재 메시지의 첨부파일 경로를 확인한다. 첨부가 없거나 여러 개라 대상을 알 수
   없으면 사용자에게 정확한 파일을 요청한다.
2. `references/targets.json`에서 목적지 경로를 포함하는 target을 확인한다.
3. 다음 명령을 실행한다.

```bash
ncl lbox-aws deploy-static-file \
  --target <target> \
  --attachment /workspace/inbox/<message-id>/<filename>
```

목적지 파일을 생략하면 첨부파일명을 target 경로 아래의 S3 key, invalidation path,
CDN URL에 공통으로 사용한다. 따라서 `police-mou-guide.html`을 첨부했다면 다음 한
줄이면 된다.

```bash
ncl lbox-aws deploy-static-file --target lbox-static-html --attachment /workspace/inbox/<message-id>/police-mou-guide.html
```

같은 디렉터리의 다른 HTML도 같은 target으로 배포한다.

```bash
ncl lbox-aws deploy-static-file --target lbox-static-html --attachment /workspace/inbox/<message-id>/another-guide.html
```

첨부파일명과 배포 이름이 달라야 할 때만 target 범위 안의 상대 경로를 지정한다.
사용자가 전체 S3 URI나 CDN URL을 명시했다면 target prefix를 제거한 나머지를
`--destination`으로 사용한다.

```bash
ncl lbox-aws deploy-static-file \
  --target lbox-static-html \
  --attachment /workspace/inbox/<message-id>/uploaded-file.html \
  --destination police-mou-guide.html
```

`--destination`은 `../`나 절대 경로로 preset 범위를 벗어날 수 없다. profile, bucket,
CloudFront distribution, 경로 prefix는 preset이 계속 고정한다.

## 상세 배포

Preset이 없을 때만 모든 목적지를 명시한다.

```bash
ncl lbox-aws deploy-static-file \
  --attachment /workspace/inbox/<message-id>/<filename> \
  --profile lbox-system \
  --s3-uri s3://<lbox-bucket>/<key> \
  --content-type text/html \
  --sse AES256 \
  --distribution-id <distribution-id> \
  --invalidation-path /<path> \
  --cdn-url https://<lbox-host>/<path>
```

호스트는 승인 전에 첨부파일의 불변 사본과 SHA-256을 만들고 승인 카드에 목적지와
해시를 표시한다. 승인 후 기존 객체 백업, 업로드, 원격 재다운로드 해시 검증,
metadata 검증, invalidation 생성과 `Completed` 대기를 순서대로 수행한다.

## 결과 처리

- 명령이 `deployment_started`를 반환하면 호스트가 관리자 발신자를 확인해 배포를
  시작한 상태라고 알린다. `approval_requested`를 반환하면 관리자 승인 대기 상태를
  알린다.
- `AWS_SSO_LOGIN_REQUIRED`가 오면 Mac mini에서 메시지에 표시된 profile로
  `aws sso login`을 완료한 뒤 같은 요청을 다시 실행한다.
- 성공 보고에는 SHA-256 일치, invalidation ID, `Completed`, CDN URL을 포함한다.
