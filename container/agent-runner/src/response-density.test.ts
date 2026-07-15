import { describe, expect, it } from 'bun:test';

import { applyResponseMode, responseDensityViolations, selectResponseMode } from './response-density.js';

const modeFor = (text: string) => selectResponseMode([{ trigger: 1, content: JSON.stringify({ text }) }]);

describe('response mode selection', () => {
  it('defaults to brief and expands only for an explicit deep request', () => {
    expect(modeFor('이 오류가 왜 생겼어?')).toBe('brief');
    expect(modeFor('두 구현을 비교 분석해줘')).toBe('deep');
  });

  it('lets an explicit brevity request override a deep keyword', () => {
    expect(modeFor('비교 결과만 간단히 알려줘')).toBe('brief');
  });

  it('uses the newest wake-eligible request instead of old accumulated context', () => {
    const mode = selectResponseMode([
      { trigger: 0, content: JSON.stringify({ text: '전체 구조를 자세히 분석해줘' }) },
      { trigger: 1, content: JSON.stringify({ text: '그래서 지금 배포돼?' }) },
    ]);
    expect(mode).toBe('brief');
  });

  it('adds a compact machine-selected directive to the turn', () => {
    const prompt = applyResponseMode('<message>확인해줘</message>', 'brief');
    expect(prompt).toStartWith('<response_mode name="brief">');
    expect(prompt).toContain('<message>확인해줘</message>');
  });
});

describe('Slack response density assessment', () => {
  it('accepts concise Markdown and meaningful status emoji in brief mode', () => {
    const answer = `배포는 보류하는 게 맞아요. 결제 회귀 한 건만 남았습니다.

- ❌ callback 중복 처리를 수정해야 해요.
- ✅ 인증과 Slack thread 경로는 통과했어요.
- [ ] 수정 후 결제 회귀 테스트를 다시 실행해요.`;

    expect(responseDensityViolations(answer, 'brief')).toEqual([]);
  });

  it('rejects a brief answer that creates report sections and too many slots', () => {
    const answer = `검증은 끝났고 결론은 맞아요.

**정확히 확인된 부분**

- 첫 번째 구현 근거예요.
- 두 번째 구현 근거예요.
- 세 번째 구현 근거예요.

**세부가 다른 부분**

- 네 번째 호출 경로예요.`;
    expect(responseDensityViolations(answer, 'brief')).toEqual(['목록 항목 4/3', '섹션 2/0']);
  });

  it('measures visible content rather than Markdown link syntax', () => {
    const shortLabelWithLongUrl = `[근거](https://example.com/${'very-long-path/'.repeat(80)})`;
    expect(responseDensityViolations(`판정은 맞아요. ${shortLabelWithLongUrl}`, 'brief')).toEqual([]);
  });

  it('allows hierarchical detail in deep mode but still has a hard ceiling', () => {
    const structured = `요약하면 A안이 적합해요.

## 비교

| 기준 | A안 | B안 |
| --- | --- | --- |
| 변경 범위 | 작음 | 큼 |

## 다음 행동

- A안으로 적용해요.
- 조건이 바뀌면 다시 검토해요.`;
    expect(responseDensityViolations(structured, 'deep')).toEqual([]);
    expect(responseDensityViolations('가'.repeat(2401), 'deep')).toEqual(['본문 글자 2401/2400']);
  });
});
