import { addKnowledge, getAllFacts, getRelevantFacts, ensureWorkspace, getIntegration, removeIntegration, saveMessage, getRecentMessages } from './knowledge/store.js';
import { answerQuestion } from './ai/claude.js';
import { hasSession, handleWizardStep, startWizard, cancelSession, listIntegrations } from './setup/wizard.js';
import * as github from './integrations/github/index.js';
import * as slackChannels from './integrations/slack-channels/index.js';
import { saveIntegration } from './knowledge/store.js';

// Map integration name → module (add new integrations here)
const INTEGRATIONS = { github, 'slack-channels': slackChannels };

const HELP_TEXT =
  '*Teammate Bot — commands:*\n\n' +
  '`info` — show all team knowledge\n' +
  '`add this: <fact>` — add a fact _(admin)_\n' +
  '`index channel #channel-name` — index a Slack channel _(admin)_\n' +
  '`sync slack` — re-sync all indexed channels _(admin)_\n' +
  '`connect github` — connect GitHub _(admin)_\n' +
  '`sync github` — re-sync GitHub repos _(admin)_\n' +
  '`integrations` — list active integrations\n' +
  '`help` — show this message\n\n' +
  'Or just ask me anything!';

export async function handleMessage(ctx) {
  const { text, userId, workspaceId, reply, isAdmin } = ctx;

  await ensureWorkspace(workspaceId, ctx.platform);

  // Always allow cancel to escape a wizard
  if (/^cancel$/i.test(text) && hasSession(userId)) {
    cancelSession(userId);
    await reply('Setup cancelled.');
    return;
  }

  // If user is mid-wizard, route there
  if (hasSession(userId)) {
    await handleWizardStep(ctx);
    return;
  }

  // ── info ────────────────────────────────────────────────────────────────────
  if (/^\/info$|^info$/i.test(text)) {
    const facts = await getAllFacts(workspaceId);
    if (facts.length === 0) {
      await reply('No team knowledge yet. Admins can add facts by typing: `add this: <fact>`');
      return;
    }
    const list = facts.map((f, i) => `${i + 1}. ${f.content}`).join('\n');
    await reply(`*Team Knowledge Base:*\n\n${list}`);
    return;
  }

  // ── add this: ───────────────────────────────────────────────────────────────
  if (/^add this:/i.test(text)) {
    if (!isAdmin) { await reply('Sorry, only admins can add to the knowledge base.'); return; }
    const content = text.replace(/^add this:/i, '').trim();
    if (!content) { await reply('Please provide content after "add this:"'); return; }
    await addKnowledge({ workspaceId, content, addedBy: userId });
    await reply(`Got it! Added to the team knowledge base:\n_"${content}"_`);
    return;
  }

  // ── index channel #name ──────────────────────────────────────────────────────
  const indexMatch = text.match(/^index\s+channel\s+(.+)$/i);
  if (indexMatch) {
    if (!isAdmin) { await reply('Sorry, only admins can index channels.'); return; }
    const channelArg = indexMatch[1].trim();
    await reply(`Looking up ${channelArg}...`);
    try {
      const channel = await slackChannels.resolveChannel(channelArg);
      const existing = await getIntegration(workspaceId, 'slack-channels');
      const channels = existing?.config?.channels ?? [];
      if (!channels.find((c) => c.id === channel.id)) channels.push(channel);
      await saveIntegration(workspaceId, 'slack-channels', existing?.token_enc ?? '', { channels });

      await reply(`Indexing *#${channel.name}*...`);
      const integration = { token_enc: '', config: { channels: [channel] } };
      const { synced, failed } = await slackChannels.sync(workspaceId, integration);
      let msg = `Done! Indexed *${synced}* messages from *#${channel.name}*.`;
      if (failed.length > 0) msg += `\n\n⚠️ Issues: ${failed.join(', ')}`;
      await reply(msg);
    } catch (err) {
      await reply(`Failed: ${err.message}`);
    }
    return;
  }

  // ── sync slack ───────────────────────────────────────────────────────────────
  if (/^sync\s+slack$/i.test(text)) {
    if (!isAdmin) { await reply('Sorry, only admins can trigger syncs.'); return; }
    const integration = await getIntegration(workspaceId, 'slack-channels');
    if (!integration) { await reply('No channels indexed yet. Use `index channel #channel-name` first.'); return; }
    await reply('Syncing all indexed channels...');
    const { synced, failed } = await slackChannels.sync(workspaceId, integration);
    let msg = `Done! Synced *${synced}* messages.`;
    if (failed.length > 0) msg += `\n\n⚠️ Issues: ${failed.join(', ')}`;
    await reply(msg);
    return;
  }

  // ── connect <integration> ────────────────────────────────────────────────────
  const connectMatch = text.match(/^connect\s+(\w+)$/i);
  if (connectMatch) {
    if (!isAdmin) { await reply('Sorry, only admins can connect integrations.'); return; }
    await startWizard(ctx, connectMatch[1].toLowerCase());
    return;
  }

  // ── disconnect <integration> ─────────────────────────────────────────────────
  const disconnectMatch = text.match(/^disconnect\s+(\w+)$/i);
  if (disconnectMatch) {
    if (!isAdmin) { await reply('Sorry, only admins can disconnect integrations.'); return; }
    const type = disconnectMatch[1].toLowerCase();
    await removeIntegration(workspaceId, type);
    await reply(`Disconnected *${type}*.`);
    return;
  }

  // ── sync <integration> ───────────────────────────────────────────────────────
  const syncMatch = text.match(/^sync\s+(\w+)$/i);
  if (syncMatch) {
    if (!isAdmin) { await reply('Sorry, only admins can trigger syncs.'); return; }
    const type = syncMatch[1].toLowerCase();
    const handler = INTEGRATIONS[type];
    if (!handler) { await reply(`Unknown integration \`${type}\`.`); return; }
    const integration = await getIntegration(workspaceId, type);
    if (!integration) {
      await reply(`No ${type} integration found. Type \`connect ${type}\` to set it up.`);
      return;
    }
    await reply(`Syncing ${type}...`);
    const { synced, failed } = await handler.sync(workspaceId, integration);
    let msg = `Done! Synced *${synced}* item(s).`;
    if (failed.length > 0) msg += `\n\n⚠️ Couldn't access: ${failed.join(', ')}`;
    await reply(msg);
    return;
  }

  // ── integrations ─────────────────────────────────────────────────────────────
  if (/^integrations$/i.test(text)) {
    await listIntegrations(workspaceId, reply);
    return;
  }

  // ── help ──────────────────────────────────────────────────────────────────────
  if (/^help$/i.test(text)) {
    await reply(HELP_TEXT);
    return;
  }

  // ── free-text question → Claude ───────────────────────────────────────────────
  const [facts, history] = await Promise.all([
    getRelevantFacts(workspaceId),
    getRecentMessages(workspaceId, userId),
  ]);

  await saveMessage(workspaceId, userId, 'user', text);
  const answer = await answerQuestion(text, facts, history);
  await saveMessage(workspaceId, userId, 'assistant', answer);
  await reply(answer);
}
