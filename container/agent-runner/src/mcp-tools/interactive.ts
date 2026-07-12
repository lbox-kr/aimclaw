/**
 * Interactive MCP tools: ask_user_question, send_card.
 *
 * ask_user_question is a blocking tool call — it writes a messages_out row
 * with a question card, then polls messages_in for the response.
 */
import { findQuestionResponse, markCompleted } from '../db/messages-in.js';
import { writeMessageOut } from '../db/messages-out.js';
import { getSessionRouting } from '../db/session-routing.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function routing() {
  return getSessionRouting();
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const askUserQuestion: McpToolDefinition = {
  tool: {
    name: 'ask_user_question',
    description:
      'Ask the user a multiple-choice question and wait for their response. This is a blocking call — execution pauses until the user responds or the timeout expires. Provide a short card title (e.g. "Confirm deletion") and an array of options — each option may be a plain string (used as both button label and result value) or an object { label, selectedLabel?, value? } where selectedLabel is the text shown on the card after the user clicks.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        title: { type: 'string', description: 'Short card title shown above the question' },
        question: { type: 'string', description: 'The question to ask' },
        options: {
          type: 'array',
          items: {
            oneOf: [
              { type: 'string' },
              {
                type: 'object',
                properties: {
                  label: { type: 'string' },
                  selectedLabel: { type: 'string' },
                  value: { type: 'string' },
                },
                required: ['label'],
              },
            ],
          },
          description: 'Options for the user to choose from (string or {label, selectedLabel?, value?})',
        },
        timeout: { type: 'number', description: 'Timeout in seconds (default: 300)' },
      },
      required: ['title', 'question', 'options'],
    },
  },
  async handler(args) {
    const title = args.title as string;
    const question = args.question as string;
    const rawOptions = args.options as unknown[];
    const timeout = ((args.timeout as number) || 300) * 1000;
    if (!title || !question || !rawOptions?.length) {
      return err('title, question, and options are required');
    }

    const options = rawOptions.map((o) => {
      if (typeof o === 'string') return { label: o, selectedLabel: o, value: o };
      const obj = o as { label: string; selectedLabel?: string; value?: string };
      return {
        label: obj.label,
        selectedLabel: obj.selectedLabel ?? obj.label,
        value: obj.value ?? obj.label,
      };
    });

    const questionId = generateId();
    const r = routing();

    // Write question card to outbound.db
    writeMessageOut({
      id: questionId,
      kind: 'chat-sdk',
      platform_id: r.platform_id,
      channel_type: r.channel_type,
      thread_id: r.thread_id,
      content: JSON.stringify({
        type: 'ask_question',
        questionId,
        title,
        question,
        options,
      }),
    });

    log(`ask_user_question: ${questionId} → "${question}" [${options.join(', ')}]`);

    // Poll for response in inbound.db (host writes the response there)
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const response = findQuestionResponse(questionId);

      if (response) {
        const parsed = JSON.parse(response.content);
        // Mark the response as completed via processing_ack (outbound.db)
        markCompleted([response.id]);

        log(`ask_user_question response: ${questionId} → ${parsed.selectedOption}`);
        return ok(parsed.selectedOption);
      }

      await sleep(1000);
    }

    log(`ask_user_question timeout: ${questionId}`);
    return err(`Question timed out after ${timeout / 1000}s`);
  },
};

export const sendCard: McpToolDefinition = {
  tool: {
    name: 'send_card',
    description:
      'Send a structured display card to the current conversation. Use fields for compact key-value facts, children for styled text/dividers/images, and actions only for URL buttons. Use ask_user_question instead when a button must return a choice.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        card: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Short card title' },
            subtitle: { type: 'string', description: 'Optional secondary context such as time, environment, or scope' },
            description: { type: 'string', description: 'One or two sentence outcome or summary' },
            imageUrl: { type: 'string', description: 'Optional card header image URL' },
            fields: {
              type: 'array',
              description: 'Compact key-value facts, usually six or fewer',
              items: {
                type: 'object',
                properties: {
                  label: { type: 'string' },
                  value: { type: 'string' },
                },
                required: ['label', 'value'],
              },
            },
            children: {
              type: 'array',
              description: 'Additional text, divider, or accessible image blocks',
              items: {
                oneOf: [
                  { type: 'string' },
                  {
                    type: 'object',
                    properties: {
                      type: { type: 'string', enum: ['text'] },
                      text: { type: 'string' },
                      style: { type: 'string', enum: ['plain', 'bold', 'muted'] },
                    },
                    required: ['type', 'text'],
                  },
                  {
                    type: 'object',
                    properties: { type: { type: 'string', enum: ['divider'] } },
                    required: ['type'],
                  },
                  {
                    type: 'object',
                    properties: {
                      type: { type: 'string', enum: ['image'] },
                      url: { type: 'string' },
                      alt: { type: 'string' },
                    },
                    required: ['type', 'url', 'alt'],
                  },
                ],
              },
            },
            actions: {
              type: 'array',
              description: 'URL buttons only. Use ask_user_question for callback choices.',
              items: {
                type: 'object',
                properties: {
                  label: { type: 'string' },
                  url: { type: 'string' },
                  style: { type: 'string', enum: ['primary', 'danger', 'default'] },
                },
                required: ['label', 'url'],
              },
            },
          },
          description: 'Accessible card structure',
        },
        fallbackText: {
          type: 'string',
          description: 'Complete plain-text summary for notifications, screen readers, and platforms without cards',
        },
      },
      required: ['card', 'fallbackText'],
    },
  },
  async handler(args) {
    const card = args.card as Record<string, unknown>;
    const fallbackText = args.fallbackText as string;
    if (!card || !fallbackText?.trim()) return err('card and fallbackText are required');

    const id = generateId();
    const r = routing();

    writeMessageOut({
      id,
      kind: 'chat-sdk',
      platform_id: r.platform_id,
      channel_type: r.channel_type,
      thread_id: r.thread_id,
      content: JSON.stringify({ type: 'card', card, fallbackText }),
    });

    log(`send_card: ${id}`);
    return ok(`Card sent (id: ${id})`);
  },
};

registerTools([askUserQuestion, sendCard]);
