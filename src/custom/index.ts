/**
 * Team custom barrel.
 *
 * 팀 TS 확장은 이 디렉토리에 additive하게 추가하고 여기서 import한다.
 * upstream 파일 수정은 최소화 — upstream과의 접점은 src/modules/index.ts의
 * import 한 줄뿐이어야 /update-nanoclaw 머지 충돌이 줄어든다.
 *
 * 예: src/custom/my-feature.ts 작성 후 아래에 `import './my-feature.js';`
 */
import './current-thread-history.js';
import './lbox-aws.js';
import './lbox-github.js';
import './slack-native-stream.js';
import './slack-user-access.js';
