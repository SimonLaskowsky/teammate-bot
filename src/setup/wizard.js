import { encrypt } from '../crypto.js';
import { saveIntegration, removeIntegration, getActiveIntegrations } from '../knowledge/store.js';
import * as github from '../integrations/github/index.js';

// Registry of available integrations — add new ones here
const INTEGRATIONS = {
  github,
};

// In-memory session state per user
// { userId → { type, step, token } }
const sessions = new Map();

export function hasSession(userId) {
  return sessions.has(userId);
}

export function cancelSession(userId) {
  sessions.delete(userId);
}

export async function startWizard(ctx, type) {
  const integration = INTEGRATIONS[type];
  if (!integration) {
    const available = Object.keys(INTEGRATIONS).join(', ');
    await ctx.reply(`Unknown integration \`${type}\`. Available: ${available}`);
    return;
  }

  sessions.set(ctx.userId, { type, step: 'awaiting_token' });

  await ctx.reply(
    `Let's connect *${integration.displayName}*!\n\n` +
    `Paste your Personal Access Token.\n` +
    `_(Generate one at https://github.com/settings/tokens — needs \`repo\` read scope)_\n\n` +
    `Type \`cancel\` at any time to stop.`
  );
}

export async function handleWizardStep(ctx) {
  const session = sessions.get(ctx.userId);
  const integration = INTEGRATIONS[session.type];

  if (session.step === 'awaiting_token') {
    const token = ctx.text.trim();
    const valid = await integration.validate(token);

    if (!valid) {
      await ctx.reply("That token doesn't seem valid. Check it and try again, or type `cancel` to stop.");
      return;
    }

    session.token = token;
    session.step = 'awaiting_repos';
    sessions.set(ctx.userId, session);

    // Fetch and show available repos so user can pick
    const repos = await integration.listRepos(token);
    if (repos.length === 0) {
      await ctx.reply(
        `Token looks good! I couldn't find any repos — paste the repo names manually:\n` +
        `Format: \`owner/repo\` — comma-separated for multiple`
      );
    } else {
      const list = repos.map((r, i) => `${i + 1}. ${r}`).join('\n');
      await ctx.reply(
        `Token looks good! Here are your repos:\n\n${list}\n\n` +
        `Reply with the numbers (e.g. \`1, 3\`), repo names, or \`all\` to index everything.`
      );
      session.repoList = repos;
      sessions.set(ctx.userId, session);
    }
    return;
  }

  if (session.step === 'awaiting_repos') {
    let repos;

    if (/^all$/i.test(ctx.text.trim()) && session.repoList) {
      repos = session.repoList;
    } else if (/^[\d\s,]+$/.test(ctx.text.trim()) && session.repoList) {
      // User replied with numbers like "1, 3, 5"
      const indices = ctx.text.split(',').map((n) => parseInt(n.trim()) - 1);
      repos = indices.map((i) => session.repoList[i]).filter(Boolean);
    } else {
      repos = ctx.text.split(',').map((r) => r.trim()).filter(Boolean);
    }

    if (repos.length === 0) {
      await ctx.reply('Please provide at least one repo (e.g. `myorg/backend`)');
      return;
    }

    const tokenEnc = encrypt(session.token);
    await saveIntegration(ctx.workspaceId, session.type, tokenEnc, { repos });
    sessions.delete(ctx.userId);

    await ctx.reply(`Syncing ${repos.length} repo(s)... give me a moment.`);
    const count = await integration.sync(ctx.workspaceId, { token_enc: tokenEnc, config: { repos } });
    await ctx.reply(
      `Done! Indexed *${count}* repo(s) into the knowledge base.\n` +
      `Type \`sync github\` anytime to pull the latest.`
    );
  }
}

export async function listIntegrations(workspaceId, reply) {
  const active = await getActiveIntegrations(workspaceId);
  if (active.length === 0) {
    await reply('No integrations connected yet.\n\nAvailable: `connect github`');
    return;
  }
  const list = active.map((i) => `• *${i.type}* — repos: ${i.config.repos?.join(', ') ?? '—'}`).join('\n');
  await reply(`*Active integrations:*\n\n${list}`);
}
