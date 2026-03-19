import { decrypt } from '../../crypto.js';
import { upsertKnowledge } from '../../knowledge/store.js';

export const name = 'github';
export const displayName = 'GitHub';

const BASE = 'https://api.github.com';

function headers(token, accept = 'application/vnd.github.v3.json') {
  return { Authorization: `Bearer ${token}`, Accept: accept };
}

export async function validate(token) {
  const res = await fetch(`${BASE}/user/repos?per_page=1`, { headers: headers(token) });
  return res.ok;
}

export async function listRepos(token) {
  const res = await fetch(`${BASE}/user/repos?per_page=100&sort=updated`, { headers: headers(token) });
  if (!res.ok) return [];
  const repos = await res.json();
  return repos.map((r) => r.full_name);
}

// Returns { synced: number, failed: string[] }
export async function sync(workspaceId, integration) {
  const token = decrypt(integration.token_enc);
  const repos = integration.config.repos ?? [];
  let synced = 0;
  const failed = [];

  for (const repo of repos) {
    try {
      // Get repo metadata — description, language, topics
      const metaRes = await fetch(`${BASE}/repos/${repo}`, { headers: headers(token) });
      if (!metaRes.ok) {
        failed.push(`${repo} (${metaRes.status})`);
        continue;
      }
      const meta = await metaRes.json();

      // Try README — fall back gracefully if missing
      let readmeText = '';
      const readmeRes = await fetch(`${BASE}/repos/${repo}/readme`, {
        headers: headers(token, 'application/vnd.github.v3.raw'),
      });
      if (readmeRes.ok) {
        readmeText = (await readmeRes.text()).slice(0, 2500);
      }

      const parts = [`GitHub repo: ${repo}`];
      if (meta.description) parts.push(`Description: ${meta.description}`);
      if (meta.language) parts.push(`Primary language: ${meta.language}`);
      if (meta.topics?.length) parts.push(`Topics: ${meta.topics.join(', ')}`);
      if (readmeText) parts.push(`README:\n${readmeText}`);

      await upsertKnowledge({
        workspaceId,
        content: parts.join('\n'),
        source: 'github',
        sourceId: `github:${repo}`,
        addedBy: 'github-integration',
      });
      synced++;
    } catch (err) {
      console.error(`[github] Failed to sync ${repo}:`, err.message);
      failed.push(repo);
    }
  }

  return { synced, failed };
}
