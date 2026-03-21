import { randomBytes, createHmac } from 'crypto';
import { decrypt } from '../../crypto.js';
import { upsertKnowledge } from '../../knowledge/store.js';

export const name = 'github';
export const displayName = 'GitHub';
export const tokenPrompt =
  'Paste your Personal Access Token.\n' +
  '_(Generate one at https://github.com/settings/tokens — needs `repo` and `admin:repo_hook` scopes)_';

const BASE = 'https://api.github.com';

function headers(token, accept = 'application/vnd.github.v3.json') {
  return { Authorization: `Bearer ${token}`, Accept: accept };
}

export function configSummary(config) {
  const repos = config.repos ?? [];
  if (repos.length === 0) return 'no repos';
  const preview = repos.slice(0, 3).join(', ');
  return repos.length > 3 ? `${preview} +${repos.length - 3} more` : preview;
}

export async function getCommitDetails(repo, sha, token) {
  const res = await fetch(`${BASE}/repos/${repo}/commits/${sha}`, { headers: headers(token) });
  if (!res.ok) return `Could not fetch commit ${sha} from ${repo}: HTTP ${res.status}`;
  const data = await res.json();
  const files = (data.files ?? [])
    .slice(0, 20)
    .map((f) => `  ${f.status}: ${f.filename} (+${f.additions}/-${f.deletions})`)
    .join('\n');
  return [
    `Commit: ${data.sha}`,
    `Author: ${data.commit.author.name}`,
    `Date: ${data.commit.author.date.slice(0, 10)}`,
    `Message: ${data.commit.message}`,
    `Stats: +${data.stats?.additions ?? 0} / -${data.stats?.deletions ?? 0} lines`,
    files ? `Files changed:\n${files}` : 'No file changes',
  ].join('\n');
}

export async function listItems(token) {
  const items = (await listRepos(token)).map((r) => ({ id: r, name: r }));
  return { items, label: 'repos' };
}

export function buildConfig(selectedItems) {
  return { repos: selectedItems.map((i) => i.id) };
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

// Split markdown into sections by heading so each section gets its own embedding
function splitMarkdown(text, maxLen = 1500) {
  const sections = text.split(/\n(?=#{1,3} )/);
  return sections
    .map((s) => s.trim())
    .filter((s) => s.length > 50)
    .map((s) => s.slice(0, maxLen));
}

async function fetchText(url, token) {
  const res = await fetch(url, { headers: headers(token, 'application/vnd.github.v3.raw') });
  return res.ok ? res.text() : null;
}

async function fetchJson(url, token) {
  const res = await fetch(url, { headers: headers(token) });
  return res.ok ? res.json() : null;
}

// ── Webhook registration ──────────────────────────────────────────────────────

export async function registerWebhooks(workspaceId, token, config) {
  if (!process.env.PUBLIC_URL) return null;
  const webhookSecret = randomBytes(32).toString('hex');
  const baseUrl = process.env.PUBLIC_URL.startsWith('http') ? process.env.PUBLIC_URL : `https://${process.env.PUBLIC_URL}`;
  const url = `${baseUrl}/webhooks/github`;
  for (const repo of config.repos ?? []) {
    const res = await fetch(`${BASE}/repos/${repo}/hooks`, {
      method: 'POST',
      headers: headers(token),
      body: JSON.stringify({
        name: 'web',
        active: true,
        events: ['push', 'pull_request', 'issues', 'issue_comment'],
        config: { url, content_type: 'json', secret: webhookSecret, insecure_ssl: '0' },
      }),
    });
    if (!res.ok) console.error(`[github] Webhook registration failed for ${repo}:`, JSON.stringify(await res.json()));
  }
  return { webhookSecret };
}

export function verifyWebhookSignature(rawBody, secret, signature) {
  const expected = 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');
  return signature === expected;
}

// ── Incremental webhook sync helpers ─────────────────────────────────────────

export async function syncRepoCommits(workspaceId, repo, token) {
  const commits = await fetchJson(`${BASE}/repos/${repo}/commits?per_page=20`, token);
  if (!commits) return;
  const summary = commits
    .map((c) => `- ${c.sha.slice(0, 7)}: ${c.commit.message.split('\n')[0]} (${c.commit.author.name}, ${c.commit.author.date.slice(0, 10)})`)
    .join('\n');
  await upsertKnowledge({
    workspaceId,
    content: `[${repo} recent commits]\n${summary}`,
    source: 'github',
    sourceId: `github:${repo}:commits`,
    addedBy: 'github-webhook',
  });
}

export async function upsertPREntry(workspaceId, repo, pr) {
  await upsertKnowledge({
    workspaceId,
    content: `[${repo} PR #${pr.number}] ${pr.title} (by ${pr.user.login}, into ${pr.base.ref})${pr.body ? '\n' + pr.body.slice(0, 500) : ''}`,
    source: 'github',
    sourceId: `github:${repo}:pr:${pr.number}`,
    addedBy: 'github-webhook',
  });
}

export async function upsertIssueEntry(workspaceId, repo, issue) {
  const labels = issue.labels?.map((l) => l.name).join(', ');
  await upsertKnowledge({
    workspaceId,
    content: `[${repo} issue #${issue.number}] ${issue.title}${labels ? ` (${labels})` : ''}${issue.body ? '\n' + issue.body.slice(0, 500) : ''}`,
    source: 'github',
    sourceId: `github:${repo}:issue:${issue.number}`,
    addedBy: 'github-webhook',
  });
}

// Returns { synced: number, failed: string[] }
export async function sync(workspaceId, integration) {
  const token = decrypt(integration.token_enc);
  const repos = integration.config.repos ?? [];
  let synced = 0;
  const failed = [];

  for (const repo of repos) {
    try {
      const meta = await fetchJson(`${BASE}/repos/${repo}`, token);
      if (!meta) { failed.push(`${repo} (not found)`); continue; }

      // ── Repo overview ────────────────────────────────────────────────────────
      const overviewParts = [`GitHub repo: ${repo}`];
      if (meta.description) overviewParts.push(`Description: ${meta.description}`);
      if (meta.language) overviewParts.push(`Primary language: ${meta.language}`);
      if (meta.topics?.length) overviewParts.push(`Topics: ${meta.topics.join(', ')}`);
      if (meta.default_branch) overviewParts.push(`Default branch: ${meta.default_branch}`);

      await upsertKnowledge({
        workspaceId,
        content: overviewParts.join('\n'),
        source: 'github',
        sourceId: `github:${repo}:meta`,
        addedBy: 'github-integration',
      });
      synced++;

      // ── README ───────────────────────────────────────────────────────────────
      const readme = await fetchText(`${BASE}/repos/${repo}/readme`, token);
      if (readme) {
        const sections = splitMarkdown(readme);
        for (let i = 0; i < sections.length; i++) {
          await upsertKnowledge({
            workspaceId,
            content: `[${repo} README] ${sections[i]}`,
            source: 'github',
            sourceId: `github:${repo}:readme:${i}`,
            addedBy: 'github-integration',
          });
          synced++;
        }
      }

      // ── package.json scripts ─────────────────────────────────────────────────
      const pkgRaw = await fetchText(`${BASE}/repos/${repo}/contents/package.json`, token);
      if (pkgRaw) {
        try {
          const pkg = JSON.parse(pkgRaw);
          if (pkg.scripts && Object.keys(pkg.scripts).length > 0) {
            const scripts = Object.entries(pkg.scripts)
              .map(([k, v]) => `  ${k}: ${v}`)
              .join('\n');
            await upsertKnowledge({
              workspaceId,
              content: `[${repo} package.json scripts]\n${scripts}`,
              source: 'github',
              sourceId: `github:${repo}:package-scripts`,
              addedBy: 'github-integration',
            });
            synced++;
          }
        } catch {
          // invalid JSON, skip
        }
      }

      // ── CONTRIBUTING.md ──────────────────────────────────────────────────────
      const contributing = await fetchText(`${BASE}/repos/${repo}/contents/CONTRIBUTING.md`, token);
      if (contributing) {
        const sections = splitMarkdown(contributing);
        for (let i = 0; i < sections.length; i++) {
          await upsertKnowledge({
            workspaceId,
            content: `[${repo} CONTRIBUTING] ${sections[i]}`,
            source: 'github',
            sourceId: `github:${repo}:contributing:${i}`,
            addedBy: 'github-integration',
          });
          synced++;
        }
      }

      // ── Open issues ──────────────────────────────────────────────────────────
      const issues = await fetchJson(
        `${BASE}/repos/${repo}/issues?state=open&per_page=30&sort=updated`,
        token
      );
      if (issues) {
        for (const issue of issues.filter((i) => !i.pull_request)) {
          const body = issue.body ? `\n${issue.body.slice(0, 500)}` : '';
          const labels = issue.labels?.map((l) => l.name).join(', ');
          await upsertKnowledge({
            workspaceId,
            content: `[${repo} issue #${issue.number}] ${issue.title}${labels ? ` (${labels})` : ''}${body}`,
            source: 'github',
            sourceId: `github:${repo}:issue:${issue.number}`,
            addedBy: 'github-integration',
          });
          synced++;

          const comments = await fetchJson(`${BASE}/repos/${repo}/issues/${issue.number}/comments?per_page=10`, token);
          if (comments?.length) {
            const text = comments.map((c) => `${c.user.login}: ${c.body.slice(0, 300)}`).join('\n---\n');
            await upsertKnowledge({
              workspaceId,
              content: `[${repo} issue #${issue.number} comments]\n${text}`,
              source: 'github',
              sourceId: `github:${repo}:issue:${issue.number}:comments`,
              addedBy: 'github-integration',
            });
            synced++;
          }
        }
      }

      // ── Recent commits ───────────────────────────────────────────────────────
      const commits = await fetchJson(
        `${BASE}/repos/${repo}/commits?per_page=20`,
        token
      );
      if (commits) {
        const summary = commits
          .map((c) => `- ${c.sha.slice(0, 7)}: ${c.commit.message.split('\n')[0]} (${c.commit.author.name}, ${c.commit.author.date.slice(0, 10)})`)
          .join('\n');
        await upsertKnowledge({
          workspaceId,
          content: `[${repo} recent commits]\n${summary}`,
          source: 'github',
          sourceId: `github:${repo}:commits`,
          addedBy: 'github-integration',
        });
        synced++;
      }

      // ── Open PRs ─────────────────────────────────────────────────────────────
      const prs = await fetchJson(
        `${BASE}/repos/${repo}/pulls?state=open&per_page=20&sort=updated`,
        token
      );
      if (prs) {
        for (const pr of prs) {
          const body = pr.body ? `\n${pr.body.slice(0, 500)}` : '';
          await upsertKnowledge({
            workspaceId,
            content: `[${repo} PR #${pr.number}] ${pr.title} (by ${pr.user.login}, into ${pr.base.ref})${body}`,
            source: 'github',
            sourceId: `github:${repo}:pr:${pr.number}`,
            addedBy: 'github-integration',
          });
          synced++;

          const comments = await fetchJson(`${BASE}/repos/${repo}/issues/${pr.number}/comments?per_page=10`, token);
          if (comments?.length) {
            const text = comments.map((c) => `${c.user.login}: ${c.body.slice(0, 300)}`).join('\n---\n');
            await upsertKnowledge({
              workspaceId,
              content: `[${repo} PR #${pr.number} comments]\n${text}`,
              source: 'github',
              sourceId: `github:${repo}:pr:${pr.number}:comments`,
              addedBy: 'github-integration',
            });
            synced++;
          }
        }
      }
    } catch (err) {
      console.error(`[github] Failed to sync ${repo}:`, err.message);
      failed.push(`${repo} (${err.message})`);
    }
  }

  return { synced, failed };
}
