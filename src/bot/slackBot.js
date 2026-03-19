import pkg from '@slack/bolt';
const { App } = pkg;
import { addKnowledge, getAllFacts, getRelevantFacts, ensureWorkspace } from '../knowledge/store.js';
import { answerQuestion } from '../ai/claude.js';

const ADMIN_USERS = process.env.ADMIN_USERS?.split(',').map((u) => u.trim()) ?? [];

export function createSlackApp() {
  const app = new App({
    token: process.env.SLACK_BOT_TOKEN,
    signingSecret: process.env.SLACK_SIGNING_SECRET,
    socketMode: true,
    appToken: process.env.SLACK_APP_TOKEN,
  });

  // "info" or "/info" — show all pinned facts
  app.command('/info', async ({ command, ack, respond }) => {
    await ack();
    const workspaceId = command.team_id;
    await ensureWorkspace(workspaceId);

    const facts = await getAllFacts(workspaceId);
    if (facts.length === 0) {
      await respond('No team knowledge yet. Admins can add facts by typing: `add this: <fact>`');
      return;
    }

    const list = facts.map((f, i) => `${i + 1}. ${f.content}`).join('\n');
    await respond({ text: `*Team Knowledge Base:*\n${list}`, response_type: 'ephemeral' });
  });

  // DM messages
  app.message(async ({ message, say }) => {
    if (message.subtype) return;

    const workspaceId = message.team;
    const userId = message.user;
    const text = message.text?.trim();

    if (!text || !workspaceId || !userId) return;

    await ensureWorkspace(workspaceId);

    if (process.env.DEBUG === 'true') {
      console.log(`[debug] user=${userId} workspace=${workspaceId} text="${text}"`);
    }

    // admin: add this: ...
    if (/^add this:/i.test(text)) {
      if (!ADMIN_USERS.includes(userId)) {
        await say(`Sorry <@${userId}>, only admins can add to the knowledge base.`);
        return;
      }
      const content = text.replace(/^add this:/i, '').trim();
      if (!content) {
        await say('Please provide content after "add this:" — e.g. `add this: we never deploy on Fridays`');
        return;
      }
      await addKnowledge({ workspaceId, content, addedBy: userId });
      await say(`Got it! Added to the team knowledge base:\n_"${content}"_`);
      return;
    }

    // free-text question
    const facts = await getRelevantFacts(workspaceId);
    const answer = await answerQuestion(text, facts);
    await say(answer);
  });

  // @mentions in channels
  app.event('app_mention', async ({ event, say }) => {
    const workspaceId = event.team;
    const text = event.text.replace(/<@[^>]+>/g, '').trim();
    if (!text || !workspaceId) return;

    await ensureWorkspace(workspaceId);
    const facts = await getRelevantFacts(workspaceId);
    const answer = await answerQuestion(text, facts);
    await say(answer);
  });

  app.error(async (error) => console.error('Slack error:', error));

  return app;
}
