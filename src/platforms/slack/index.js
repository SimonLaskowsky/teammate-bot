import pkg from '@slack/bolt';
const { App } = pkg;
import { handleMessage } from '../../handler.js';
import { indexChannel } from '../../integrations/slack-channels/index.js';
import { ensureWorkspace, upsertKnowledge } from '../../knowledge/store.js';

// Simple in-memory cache so we don't call conversations.info on every message
const channelNameCache = new Map();
async function getChannelName(client, channelId) {
  if (channelNameCache.has(channelId)) return channelNameCache.get(channelId);
  try {
    const info = await client.conversations.info({ channel: channelId });
    channelNameCache.set(channelId, info.channel.name);
    return info.channel.name;
  } catch {
    return channelId; // fallback to raw ID
  }
}

const ADMIN_USERS = process.env.ADMIN_USERS?.split(',').map((u) => u.trim()) ?? [];

function makeCtx({ text, userId, workspaceId, say, channelHistory = [] }) {
  return { text, userId, workspaceId, platform: 'slack', isAdmin: ADMIN_USERS.includes(userId), reply: say, channelHistory };
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

  app.message(async ({ message, say, client }) => {
    if (message.subtype || !message.text || !message.user) return;

    if (message.channel_type === 'im') {
      // DM: full Q&A
      await handleMessage(makeCtx({ text: message.text.trim(), userId: message.user, workspaceId: message.team, say }));
    } else {
      // Channel: passively absorb as knowledge so the bot follows the conversation
      const channelName = await getChannelName(client, message.channel);
      const workspaceId = message.team ?? message.team_id;
      console.log(`[live-listener] #${channelName}: ${message.text.trim().slice(0, 60)}`);
      upsertKnowledge({
        workspaceId,
        content: `[#${channelName}] ${message.text.trim()}`,
        source: 'slack',
        sourceId: `slack:${message.channel}:${message.ts}`,
        addedBy: 'live-listener',
      }).catch((err) => console.error('[live-listener]', err.message));
    }
  });

  app.event('app_mention', async ({ event, say, client }) => {
    const text = event.text.replace(/<@[^>]+>/g, '').trim();
    if (!text) return;

    // Fetch recent channel messages so the bot has live conversation context
    let channelHistory = [];
    try {
      const result = await client.conversations.history({ channel: event.channel, limit: 30 });
      channelHistory = (result.messages ?? [])
        .filter((m) => m.type === 'message' && !m.subtype && m.text && m.user)
        .reverse() // oldest first
        .map((m) => `<@${m.user}>: ${m.text}`);
    } catch (err) {
      console.error('[channel-context] Failed to fetch history:', err.message);
    }

    await handleMessage(makeCtx({ text, userId: event.user, workspaceId: event.team, say, channelHistory }));
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
