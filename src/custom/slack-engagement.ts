import type { ChannelDefaults } from '../channels/adapter.js';

/**
 * AimClaw requires an explicit platform mention for every Slack group turn.
 * Keep this policy outside the skill-installed Slack adapter so re-applying
 * /add-slack or /update-skills cannot restore mention-sticky by overwriting it.
 */
export function withAimClawSlackEngagement(
  channelKey: string,
  channelType: string | undefined,
  defaults: ChannelDefaults,
): ChannelDefaults {
  if ((channelType ?? channelKey) !== 'slack' || defaults.group.engageMode === 'mention') return defaults;
  return { ...defaults, group: { ...defaults.group, engageMode: 'mention' } };
}
