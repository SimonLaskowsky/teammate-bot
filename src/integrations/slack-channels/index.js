import { upsertKnowledge, getIntegration, saveIntegration } from '../../knowledge/store.js';

export const name = 'slack-channels';
export const displayName = 'Slack Channels';
export const needsToken = false;

export function configSummary(config) {
  const channels = config.channels ?? [];
  if (channels.length === 0) return 'no channels indexed';
  return channels.map((c) => `#${c.name}`).join(', ');
}

const SLACK_API = 'https://slack.com/api';

function slackHeaders() {
  return { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` };
}

export async function resolveChannel(input) {
  // Slack auto-formats channel mentions as <#C07ABC123|channel-name> — extract ID directly
  const mentionMatch = input.match(/^<#([A-Za-z0-9]+)\|(.+)>$/);
  if (mentionMatch) return { id: mentionMatch[1], name: mentionMatch[2] };

  // Plain text: #channel-name or channel-name
  const clean = input.replace(/^#/, '').trim();

  const res = await fetch(
    `${SLACK_API}/conversations.list?limit=200&exclude_archived=true&types=public_channel`,
    { headers: slackHeaders() }
  );
  const data = await res.json();
  if (!data.ok) throw new Error(`Slack API error: ${data.error}`);

  const channel = data.channels.find((c) => c.name === clean || c.name_normalized === clean);
  if (!channel) {
    throw new Error(
      `Channel #${clean} not found. Make sure:\n` +
      `1. You invited the bot: \`/invite @Teammate\` in the channel\n` +
      `2. The \`channels:read\` scope is added to the Slack app and reinstalled`
    );
  }
  return { id: channel.id, name: channel.name };
}

// Add a channel to the integration config and sync it — used by both the command and auto-join
export async function indexChannel(workspaceId, channel) {
  const existing = await getIntegration(workspaceId, 'slack-channels');
  const channels = existing?.config?.channels ?? [];
  if (!channels.find((c) => c.id === channel.id)) channels.push(channel);
  await saveIntegration(workspaceId, 'slack-channels', existing?.token_enc ?? '', { channels });
  return sync(workspaceId, { token_enc: '', config: { channels: [channel] } });
}

async function resolveUsers(userIds) {
  const map = new Map();
  await Promise.all([...new Set(userIds)].map(async (userId) => {
    try {
      const res = await fetch(`${SLACK_API}/users.info?user=${userId}`, { headers: slackHeaders() });
      const data = await res.json();
      if (data.ok) {
        map.set(userId, data.user.profile.display_name || data.user.real_name || userId);
      }
    } catch {
      // fallback to userId handled below
    }
  }));
  return map;
}

// Returns { synced, failed }
export async function sync(workspaceId, integration) {
  const channels = integration.config.channels ?? [];
  let synced = 0;
  const failed = [];

  for (const { id, name } of channels) {
    try {
      const res = await fetch(
        `${SLACK_API}/conversations.history?channel=${id}&limit=200`,
        { headers: slackHeaders() }
      );
      const data = await res.json();
      if (!data.ok) { failed.push(`#${name} (${data.error})`); continue; }

      const messages = (data.messages ?? [])
        .filter((m) => m.type === 'message' && !m.subtype && m.text?.trim().length > 3)
        .reverse();

      const userMap = await resolveUsers(messages.map((m) => m.user).filter(Boolean));

      for (const msg of messages) {
        const userName = userMap.get(msg.user) ?? msg.user ?? 'unknown';
        await upsertKnowledge({
          workspaceId,
          content: `[#${name}] ${userName}: ${msg.text}`,
          source: 'slack',
          sourceId: `slack:${id}:${msg.ts}`,
          addedBy: 'slack-indexer',
        });
      }
      synced += messages.length;
    } catch (err) {
      console.error(`[slack-channels] Failed to sync #${name}:`, err.message);
      failed.push(`#${name} (${err.message})`);
    }
  }

  return { synced, failed };
}
