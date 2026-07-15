import type { MessageInRow } from './db/messages-in.js';

const MODES = {
  brief: {
    limits: [600, 3, 0, 0],
    instruction:
      '<response_mode name="brief">첫 문장에 직접 답하세요. 추가 설명은 결론을 바꾸는 핵심 근거, 중대한 예외, 다음 행동만 남겨 최대 3개 항목으로 쓰고 제목은 만들지 마세요.</response_mode>',
  },
  deep: {
    limits: [2400, 12, 5, 8],
    instruction:
      '<response_mode name="deep">먼저 결론을 2~3문장으로 요약하고, 필요한 경우에만 서로 다른 판단 정보를 최대 5개 섹션으로 구조화하세요. 조사 깊이와 사용자에게 보일 답변 길이는 분리하세요.</response_mode>',
  },
} as const;

export type ResponseMode = keyof typeof MODES;

const EXPLICIT_BRIEF_RE = /간단히|간략히|짧게|요약만|결론만|한\s*줄|brief/i;
const EXPLICIT_DEEP_RE =
  /조사|비교|분석|보고(?:서)?|자세히|상세(?:히)?|깊게|빠짐없이|근거(?:를|가)?\s*모두|전체\s*근거|deep/i;

/** Select from the newest wake-eligible request so old turns cannot leak `deep`. */
export function selectResponseMode(messages: Array<Pick<MessageInRow, 'content' | 'trigger'>>): ResponseMode {
  const message = [...messages].reverse().find(({ trigger }) => trigger === 1) ?? messages.at(-1);
  const text = message ? requestText(message.content) : '';
  if (EXPLICIT_BRIEF_RE.test(text)) return 'brief';
  return EXPLICIT_DEEP_RE.test(text) ? 'deep' : 'brief';
}

export function applyResponseMode(prompt: string, mode: ResponseMode): string {
  return `${MODES[mode].instruction}\n${prompt}`;
}

/**
 * Return only exceeded budgets. Markdown syntax and emoji do not add density;
 * visible volume and structural slots do.
 */
export function responseDensityViolations(markdown: string, mode: ResponseMode): string[] {
  const lines = markdown.split(/\r?\n/);
  const [maxChars, maxItems, maxSections, maxRows] = MODES[mode].limits;
  const checks: Array<[string, number, number]> = [
    ['본문 글자', [...visibleText(markdown)].length, maxChars],
    ['목록 항목', lines.filter((line) => /^\s*(?:[-*+]\s+|\d+[.)]\s+)/.test(line)).length, maxItems],
    [
      '섹션',
      lines.filter((line) => /^\s*#{1,6}\s+\S/.test(line) || /^\s*(?:[✅⚠️❌⏳]\s*)?\*\*[^*\n]+\*\*\s*$/.test(line))
        .length,
      maxSections,
    ],
    [
      '표 행',
      lines.filter((line) => {
        const row = line.trim();
        return row.startsWith('|') && row.endsWith('|') && !/^\|(?:\s*:?-+:?\s*\|)+$/.test(row);
      }).length,
      maxRows,
    ],
  ];

  return checks
    .filter(([, actual, limit]) => actual > limit)
    .map(([label, actual, limit]) => `${label} ${actual}/${limit}`);
}

function requestText(content: string): string {
  try {
    const value = JSON.parse(content) as Record<string, unknown>;
    for (const key of ['text', 'prompt', 'message']) {
      if (typeof value[key] === 'string') return value[key];
    }
  } catch {
    // Legacy/plain content is still useful for mode selection.
  }
  return content;
}

function visibleText(markdown: string): string {
  return markdown
    .replace(/```[^\n]*\n?/g, '')
    .replace(/```/g, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<https?:\/\/[^|>]+\|([^>]+)>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/gm, '')
    .replace(/^\s*\[(?: |x|X)\]\s*/gm, '')
    .replace(/[*_~`|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
