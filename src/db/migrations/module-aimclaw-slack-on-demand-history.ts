import type { Migration } from './index.js';

/**
 * AimClaw reads missing Slack thread context through read_current_thread only
 * after the agent is invoked. Existing auto/approval wirings used accumulate,
 * which persisted plain traffic and created sessions before any invocation.
 */
export const moduleAimClawSlackOnDemandHistory: Migration = {
  version: 20,
  name: 'aimclaw-slack-on-demand-history',
  up(db) {
    db.exec(`
      UPDATE messaging_group_agents
         SET ignored_message_policy = 'drop'
       WHERE ignored_message_policy = 'accumulate'
         AND engage_mode IN ('mention', 'mention-sticky')
         AND messaging_group_id IN (
           SELECT id
             FROM messaging_groups
            WHERE channel_type = 'slack'
              AND is_group = 1
         )
    `);
  },
};
