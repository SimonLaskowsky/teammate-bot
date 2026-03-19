import { upsertKnowledge } from '../../knowledge/store.js';

export const name = 'slack-channels';
export const displayName = 'Slack Channels';
export const needsToken = false;

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
        .filter((m) => m.type === 'message' && !m.subtype && m.text?.length > 30)
        .reverse();

      for (const msg of messages) {
        await upsertKnowledge({
          workspaceId,
          content: `[#${name}] ${msg.text}`,
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
