import { addKnowledge, getAllFacts, getManualFacts, removeManualFact, getRelevantFacts, ensureWorkspace, getIntegration, removeIntegration, saveMessage, getRecentMessages } from './knowledge/store.js';
import { answerQuestion } from './ai/claude.js';
import { hasSession, handleWizardStep, startWizard, cancelSession, listIntegrations } from './setup/wizard.js';
import * as github from './integrations/github/index.js';
import * as clickup from './integrations/clickup/index.js';
import * as slackChannels from './integrations/slack-channels/index.js';
import { decrypt } from './crypto.js';

// Map integration name → module (add new integrations here)
const INTEGRATIONS = { github, clickup, 'slack-channels': slackChannels };

const HELP_TEXT =
  '*Teammate Bot — commands:*\n\n' +
  '`info` — show knowledge base summary\n' +
  '`add this: <fact>` — add a fact _(admin)_\n' +
  '`remove this: <text>` — remove matching manual facts _(admin)_\n' +
  '`index channel #channel-name` — index a Slack channel _(admin)_\n' +
  '`sync slack` — re-sync all indexed channels _(admin)_\n' +
  '`connect github` — connect GitHub _(admin)_\n' +
  '`sync github` — re-sync GitHub repos _(admin)_\n' +
  '`connect clickup` — connect ClickUp _(admin)_\n' +
  '`sync clickup` — re-sync ClickUp tasks _(admin)_\n' +
  '`integrations` — list active integrations\n' +
  '`help` — show this message\n\n' +
  'Or just ask me anything!';

export async function handleMessage(ctx) {
  const { text, userId, workspaceId, reply, isAdmin, channelHistory = [] } = ctx;

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


  // ── debug search: ───────────────────────────────────────────────────────────
  const debugSearchMatch = text.match(/^debug search:\s*(.+)$/i);
  if (debugSearchMatch) {
    if (!isAdmin) { await reply('Admin only.'); return; }
    const query = debugSearchMatch[1].trim();
    const facts = await getRelevantFacts(workspaceId, query);
    const lines = facts.slice(0, 10).map((f, i) => `${i + 1}. [${f.source ?? 'manual'}] ${f.content.slice(0, 120)}`).join('\n');
    await reply(`*Top ${Math.min(facts.length, 10)} results for "${query}":*\n\n${lines}`);
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

  // ── remove this: ─────────────────────────────────────────────────────────────
  if (/^remove this:/i.test(text)) {
    if (!isAdmin) { await reply('Sorry, only admins can remove facts.'); return; }
    const query = text.replace(/^remove this:/i, '').trim();
    if (!query) { await reply('Please provide text to match after "remove this:"'); return; }
    const count = await removeManualFact(workspaceId, query);
    if (count === 0) await reply(`No manual facts found matching _"${query}"_.`);
    else await reply(`Removed *${count}* fact(s) matching _"${query}"_.`);
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
      await reply(`Indexing *#${channel.name}*...`);
      const { synced, failed } = await slackChannels.indexChannel(workspaceId, channel);
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

  // ── free-text question → Claude (agentic) ────────────────────────────────────
  const history = await getRecentMessages(workspaceId, userId);

  const toolHandlers = {
    search_knowledge: async ({ query }) => {
      const facts = await getRelevantFacts(workspaceId, query);
      return facts.length
        ? facts.map((f) => `- ${f.content}`).join('\n')
        : 'No relevant results found in knowledge base.';
    },
    github_get_commit: async ({ repo, sha }) => {
      const integration = await getIntegration(workspaceId, 'github');
      if (!integration) return 'GitHub integration not connected.';
      const token = decrypt(integration.token_enc);
      return github.getCommitDetails(repo, sha, token);
    },
    clickup_get_time_entries: async ({ assignee_name, start_date, end_date }) => {
      const integration = await getIntegration(workspaceId, 'clickup');
      if (!integration) return 'ClickUp integration not connected.';
      const token = decrypt(integration.token_enc);
      const teamId = integration.config.workspaces?.[0]?.id;
      if (!teamId) return 'No ClickUp workspace found in integration config.';
      return clickup.getTimeEntries(teamId, token, { assigneeName: assignee_name, startDate: start_date, endDate: end_date });
    },
  };

  // ── info ─────────────────────────────────────────────────────────────────────
  if (/^\/info$|^info$/i.test(text)) {
    const manualFacts = await getManualFacts(workspaceId);
    const rulesSection = manualFacts.length
      ? ':warning: *Rules & Norms*\n' + manualFacts.map((f) => `- ${f}`).join('\n')
      : '';

    const answer = await answerQuestion(
      'Generate a compact team overview using the knowledge base. ' +
      'CRITICAL: only include facts from search results — never invent or infer anything. Skip sections with no real data.\n\n' +
      (rulesSection
        ? `The Rules & Norms section is already written below — do NOT add to it or invent more rules:\n${rulesSection}\n\n`
        : 'There are no team rules in the knowledge base yet — skip the Rules section entirely.\n\n') +
      'Search for and write these remaining sections in Slack format (emoji + *bold* header, bullet list):\n\n' +
      ':busts_in_silhouette: *Team*\n' +
      '- Search for people, names, roles, who does what. Only include if found. One bullet per person: name — role/what they do.\n\n' +
      ':hammer_and_wrench: *Tech Stack*\n' +
      '- Languages on one line, key frameworks/tools on next line. Tight.\n\n' +
      ':rocket: *Active Work*\n' +
      '- ClickUp tasks that are "in progress" or high priority only. Skip "Get Started with ClickUp" onboarding tasks. Format: task name — status — assignee\n\n' +
      ':file_folder: *Key Projects*\n' +
      '- Real projects only (skip tutorials, mini-projects, old recruitment tasks). One bullet: *repo-name* — one sentence what it does.\n\n' +
      'Start your response with the Rules section if it exists, then the rest. No commits. No time entries. No preamble.',
      [], [], { onStatus: ctx.onStatus, toolHandlers }
    );
    await reply(answer);
    return;
  }

  await saveMessage(workspaceId, userId, 'user', text);
  const answer = await answerQuestion(text, history, channelHistory, { onStatus: ctx.onStatus, toolHandlers });
  await saveMessage(workspaceId, userId, 'assistant', answer);
  await reply(answer);
}
