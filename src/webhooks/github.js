import { getAllActiveIntegrations, deleteKnowledge } from '../knowledge/store.js';
import { decrypt } from '../crypto.js';
import {
  verifyWebhookSignature,
  syncRepoCommits,
  upsertPREntry,
  upsertIssueEntry,
} from '../integrations/github/index.js';

export async function handleGithubWebhook(req, res) {
  const event = req.headers['x-github-event'];
  const signature = req.headers['x-hub-signature-256'];
  const payload = req.body;
  const repo = payload.repository?.full_name;

  if (!repo) return res.sendStatus(400);

  // Find the workspace that has this repo connected
  const integrations = await getAllActiveIntegrations();
  const integration = integrations.find(
    (i) => i.type === 'github' && i.config.repos?.includes(repo)
  );
  if (!integration) return res.sendStatus(404);

  // Verify HMAC signature if webhook secret is stored
  if (integration.config.webhookSecret) {
    if (!verifyWebhookSignature(req.rawBody, integration.config.webhookSecret, signature)) {
      return res.sendStatus(401);
    }
  }

  const token = decrypt(integration.token_enc);
  const workspaceId = integration.workspace_id;

  try {
    if (event === 'push') {
      // Only sync default branch pushes
      const branch = payload.ref?.replace('refs/heads/', '');
      if (branch === payload.repository?.default_branch) {
        await syncRepoCommits(workspaceId, repo, token);
        console.log(`[webhook:github] Updated commits for ${repo}`);
      }
    } else if (event === 'pull_request') {
      const { action, pull_request: pr } = payload;
      if (['opened', 'edited', 'reopened', 'synchronize'].includes(action)) {
        await upsertPREntry(workspaceId, repo, pr);
      } else if (action === 'closed') {
        await deleteKnowledge(workspaceId, `github:${repo}:pr:${pr.number}`);
      }
      console.log(`[webhook:github] PR #${pr.number} ${action} in ${repo}`);
    } else if (event === 'issues') {
      const { action, issue } = payload;
      if (issue.pull_request) return res.sendStatus(200); // skip PR-linked issues
      if (['opened', 'edited', 'reopened'].includes(action)) {
        await upsertIssueEntry(workspaceId, repo, issue);
      } else if (['closed', 'deleted'].includes(action)) {
        await deleteKnowledge(workspaceId, `github:${repo}:issue:${issue.number}`);
      }
      console.log(`[webhook:github] Issue #${issue.number} ${action} in ${repo}`);
    }
  } catch (err) {
    console.error('[webhook:github] Error:', err.message);
    return res.sendStatus(500);
  }

  res.sendStatus(200);
}
