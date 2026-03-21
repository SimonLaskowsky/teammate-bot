import { getAllActiveIntegrations } from '../knowledge/store.js';
import { decrypt } from '../crypto.js';
import { syncSingleTask, deleteTask } from '../integrations/clickup/index.js';

const UPSERT_EVENTS = ['taskCreated', 'taskUpdated', 'taskStatusUpdated', 'taskAssigneeUpdated', 'taskCommentPosted', 'taskCommentUpdated'];

export async function handleClickupWebhook(req, res) {
  const { workspaceId, token: webhookToken } = req.params;
  const { event, task_id } = req.body ?? {};

  if (!workspaceId || !webhookToken || !event) return res.sendStatus(400);

  // Find integration and verify the token embedded in the URL
  const integrations = await getAllActiveIntegrations();
  const integration = integrations.find(
    (i) => i.type === 'clickup' && i.workspace_id === workspaceId && i.config.webhookToken === webhookToken
  );
  if (!integration) return res.sendStatus(401);

  const clickupToken = decrypt(integration.token_enc);

  try {
    if (event === 'taskDeleted') {
      await deleteTask(workspaceId, task_id);
      console.log(`[webhook:clickup] Deleted task ${task_id}`);
    } else if (UPSERT_EVENTS.includes(event)) {
      await syncSingleTask(workspaceId, task_id, clickupToken);
      console.log(`[webhook:clickup] Synced task ${task_id} (${event})`);
    }
  } catch (err) {
    console.error('[webhook:clickup] Error:', err.message);
    return res.sendStatus(500);
  }

  res.sendStatus(200);
}
