import { getAllActiveIntegrations } from './knowledge/store.js';
import * as github from './integrations/github/index.js';
import * as clickup from './integrations/clickup/index.js';
import * as slackChannels from './integrations/slack-channels/index.js';

const HANDLERS = { github, clickup, 'slack-channels': slackChannels };
const INTERVAL_MS = (Number(process.env.SYNC_INTERVAL_MINUTES) || 60) * 60 * 1000;

async function syncAll() {
  const integrations = await getAllActiveIntegrations().catch((err) => {
    console.error('[scheduler] Failed to load integrations:', err.message);
    return [];
  });

  for (const integration of integrations) {
    const handler = HANDLERS[integration.type];
    if (!handler) continue;
    try {
      const { synced } = await handler.sync(integration.workspace_id, integration);
      console.log(`[scheduler] ${integration.type} synced ${synced} items`);
    } catch (err) {
      console.error(`[scheduler] ${integration.type} sync failed:`, err.message);
    }
  }
}

export function startScheduler() {
  const minutes = INTERVAL_MS / 60_000;
  console.log(`[scheduler] Auto-sync every ${minutes} minutes`);
  setInterval(syncAll, INTERVAL_MS);
}
