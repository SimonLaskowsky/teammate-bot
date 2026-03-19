import { upsertKnowledge } from '../../knowledge/store.js';

export const name = 'slack-channels';
export const displayName = 'Slack Channels';
export const needsToken = false;

const SLACK_API = 'https://slack.com/api';

function slackHeaders() {
  return { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` };
}

export async function resolveChannel(nameOrId) {
  // If it looks like an ID already (C01234ABC), return as-is
  if (/^[A-Z0-9]{9,11}$/.test(nameOrId)) return { id: nameOrId, name: nameOrId };

  const clean = nameOrId.replace(/^#/, '');
  const res = await fetch(`${SLACK_API}/conversations.list?limit=200&exclude_archived=true`, {
    headers: slackHeaders(),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error);

  const channel = data.channels.find((c) => c.name === clean);
  if (!channel) throw new Error(`Channel #${clean} not found — make sure the bot is invited to it first`);
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
