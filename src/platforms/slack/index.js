import pkg from '@slack/bolt';
const { App } = pkg;
import { handleMessage } from '../../handler.js';
import { indexChannel } from '../../integrations/slack-channels/index.js';
import { ensureWorkspace } from '../../knowledge/store.js';

const ADMIN_USERS = process.env.ADMIN_USERS?.split(',').map((u) => u.trim()) ?? [];

function makeCtx({ text, userId, workspaceId, say }) {
  return { text, userId, workspaceId, platform: 'slack', isAdmin: ADMIN_USERS.includes(userId), reply: say };
}

export function createSlackApp() {
  const app = new App({
    token: process.env.SLACK_BOT_TOKEN,
    signingSecret: process.env.SLACK_SIGNING_SECRET,
    socketMode: true,
    appToken: process.env.SLACK_APP_TOKEN,
  });

  app.command('/info', async ({ command, ack, respond }) => {
    await ack();
    await handleMessage(makeCtx({
      text: 'info',
      userId: command.user_id,
      workspaceId: command.team_id,
      say: (text) => respond({ text, response_type: 'ephemeral' }),
    }));
  });

  app.message(async ({ message, say }) => {
    if (message.subtype || !message.text || !message.user) return;
    await handleMessage(makeCtx({ text: message.text.trim(), userId: message.user, workspaceId: message.team, say }));
  });

  app.event('app_mention', async ({ event, say }) => {
    const text = event.text.replace(/<@[^>]+>/g, '').trim();
    if (!text) return;
    await handleMessage(makeCtx({ text, userId: event.user, workspaceId: event.team, say }));
  });

  // Auto-index channel when bot is invited to it
  app.event('member_joined_channel', async ({ event, client }) => {
    const auth = await client.auth.test();
    if (event.user !== auth.user_id) return; // someone else joined, not the bot

    const workspaceId = event.team;
    const channelId = event.channel;

    try {
      await ensureWorkspace(workspaceId);
      // Look up channel name
      const info = await client.conversations.info({ channel: channelId });
      const channel = { id: channelId, name: info.channel.name };
      const { synced } = await indexChannel(workspaceId, channel);
      console.log(`[auto-index] Indexed #${channel.name}: ${synced} messages`);
    } catch (err) {
      console.error('[auto-index] Failed:', err.message);
    }
  });

  app.error(async (error) => console.error('Slack error:', error));

  return app;
}
