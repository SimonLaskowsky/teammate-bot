import { decrypt } from '../../crypto.js';
import { upsertKnowledge } from '../../knowledge/store.js';

export const name = 'github';
export const displayName = 'GitHub';

export async function validate(token) {
  const res = await fetch('https://api.github.com/user', {
    headers: { Authorization: `Bearer ${token}` },
  });
  return res.ok;
}

export async function listRepos(token) {
  const res = await fetch('https://api.github.com/user/repos?per_page=100&sort=updated', {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return [];
  const repos = await res.json();
  return repos.map((r) => r.full_name);
}

export async function sync(workspaceId, integration) {
  const token = decrypt(integration.token_enc);
  const repos = integration.config.repos ?? [];
  let synced = 0;

  for (const repo of repos) {
    try {
      const res = await fetch(`https://api.github.com/repos/${repo}/readme`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.v3.raw' },
      });

      if (res.ok) {
        const readme = await res.text();
        await upsertKnowledge({
          workspaceId,
          content: `GitHub README (${repo}):\n${readme.slice(0, 3000)}`,
          source: 'github',
          sourceId: `github:${repo}:README`,
          addedBy: 'github-integration',
        });
        synced++;
      }
    } catch (err) {
      console.error(`[github] Failed to sync ${repo}:`, err.message);
    }
  }

  return synced;
}
