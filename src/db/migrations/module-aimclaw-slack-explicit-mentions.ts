import type { Migration } from './index.js';

/**
 * Slack group threads are shared human conversations. mention-sticky treats
 * every follow-up after the first invocation as a new request, so existing
 * AimClaw wirings must move to explicit mentions along with the adapter
 * default. DMs and other channels keep their existing behavior.
 */
export const moduleAimClawSlackExplicitMentions: Migration = {
  version: 21,
  name: 'aimclaw-slack-explicit-mentions',
  up(db) {
    db.exec(`
      UPDATE messaging_group_agents
         SET engage_mode = 'mention'
       WHERE engage_mode = 'mention-sticky'
         AND messaging_group_id IN (
           SELECT id
             FROM messaging_groups
            WHERE channel_type = 'slack'
              AND is_group = 1
         )
    `);
  },
};
