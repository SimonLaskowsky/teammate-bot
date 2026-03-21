import { encrypt } from '../crypto.js';
import { saveIntegration, removeIntegration, getActiveIntegrations } from '../knowledge/store.js';
import * as github from '../integrations/github/index.js';
import * as clickup from '../integrations/clickup/index.js';

// Registry of available integrations — add new ones here
const INTEGRATIONS = { github, clickup };

// In-memory session state per user
// { userId → { type, step, token, itemList } }
const sessions = new Map();

export function hasSession(userId) { return sessions.has(userId); }
export function cancelSession(userId) { sessions.delete(userId); }

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
    `${integration.tokenPrompt}\n\n` +
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
    sessions.set(ctx.userId, session);

    // If integration has selectable items, list them
    const listed = integration.listItems ? await integration.listItems(token) : null;

    if (!listed || listed.items.length === 0) {
      // No selection step — save immediately and sync
      await saveAndSync(ctx, session, integration, []);
      return;
    }

    session.step = 'awaiting_selection';
    session.itemList = listed.items;
    sessions.set(ctx.userId, session);

    const list = listed.items.map((item, i) => `${i + 1}. ${item.name}`).join('\n');
    await ctx.reply(
      `Token looks good! Here are your ${listed.label}:\n\n${list}\n\n` +
      `Reply with the numbers (e.g. \`1, 3\`), names, or \`all\` to index everything.`
    );
    return;
  }

  if (session.step === 'awaiting_selection') {
    const itemList = session.itemList ?? [];
    let selected;

    if (/^all$/i.test(ctx.text.trim())) {
      selected = itemList;
    } else if (/^[\d\s,]+$/.test(ctx.text.trim())) {
      const indices = ctx.text.split(',').map((n) => parseInt(n.trim()) - 1);
      selected = indices.map((i) => itemList[i]).filter(Boolean);
    } else {
      const names = ctx.text.split(',').map((s) => s.trim().toLowerCase());
      selected = itemList.filter((item) => names.includes(item.name.toLowerCase()));
    }

    if (selected.length === 0) {
      await ctx.reply('Please select at least one item. Reply with numbers, names, or `all`.');
      return;
    }

    await saveAndSync(ctx, session, integration, selected);
  }
}

async function saveAndSync(ctx, session, integration, selectedItems) {
  const tokenEnc = encrypt(session.token);
  let config = integration.buildConfig ? integration.buildConfig(selectedItems) : {};

  // Register webhooks for real-time updates if PUBLIC_URL is configured
  if (process.env.PUBLIC_URL && integration.registerWebhooks) {
    const webhookConfig = await integration
      .registerWebhooks(ctx.workspaceId, session.token, config)
      .catch((err) => { console.error('[wizard] Webhook registration failed:', err.message); return null; });
    if (webhookConfig) {
      config = { ...config, ...webhookConfig };
      console.log(`[wizard] Registered webhooks for ${integration.displayName}`);
    }
  }

  await saveIntegration(ctx.workspaceId, session.type, tokenEnc, config);
  sessions.delete(ctx.userId);

  await ctx.reply(`Got it! Syncing *${integration.displayName}*... give me a moment.`);
  const { synced, failed } = await integration.sync(ctx.workspaceId, { token_enc: tokenEnc, config });
  let msg = `Done! Indexed *${synced}* item(s) from *${integration.displayName}*.`;
  if (failed.length > 0) msg += `\n\n⚠️ Issues: ${failed.join(', ')}`;
  await ctx.reply(msg);
}

export async function listIntegrations(workspaceId, reply) {
  const active = await getActiveIntegrations(workspaceId);
  if (active.length === 0) {
    const available = Object.keys(INTEGRATIONS).map((k) => `\`connect ${k}\``).join(', ');
    await reply(`No integrations connected yet.\n\nAvailable: ${available}`);
    return;
  }
  const list = active.map((i) => {
    const integration = INTEGRATIONS[i.type];
    const summary = integration?.configSummary?.(i.config) ?? JSON.stringify(i.config);
    return `• *${i.type}* — ${summary}`;
  }).join('\n');
  await reply(`*Active integrations:*\n\n${list}`);
}
