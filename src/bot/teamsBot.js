import { ActivityHandler, MessageFactory } from 'botbuilder';
import { addKnowledge, getAllFacts, getRelevantFacts, ensureWorkspace } from '../knowledge/store.js';
import { answerQuestion } from '../ai/claude.js';

const ADMIN_USERS = process.env.ADMIN_USERS?.split(',').map((u) => u.trim()) ?? [];

// Strip @mention XML tags that Teams prepends in channel messages: <at>Teammate</at>
function stripMention(text = '') {
  return text.replace(/<at>[^<]*<\/at>/g, '').trim();
}

export class TeammateBot extends ActivityHandler {
  constructor() {
    super();

    this.onMessage(async (context, next) => {
      const text = stripMention(context.activity.text);
      const userId = context.activity.from.id;

      // Use tenantId as the workspace identifier (works for single-company MVP)
      const workspaceId =
        context.activity.conversation.tenantId ??
        context.activity.channelData?.team?.id;

      if (process.env.DEBUG === 'true') {
        console.log(`[debug] from.id=${userId} tenantId=${workspaceId} text="${text}"`);
      }

      if (!text || !workspaceId) {
        await next();
        return;
      }

      await ensureWorkspace(workspaceId, 'teams');

      // --- /info or "info" ---
      if (/^\/info$/i.test(text) || /^info$/i.test(text)) {
        const facts = await getAllFacts(workspaceId);

        if (facts.length === 0) {
          await context.sendActivity(
            MessageFactory.text(
              'No team knowledge yet. Admins can add facts by typing: `add this: <fact>`'
            )
          );
        } else {
          const list = facts.map((f, i) => `${i + 1}. ${f.content}`).join('\n');
          await context.sendActivity(MessageFactory.text(`**Team Knowledge Base:**\n\n${list}`));
        }

        await next();
        return;
      }

      // --- add this: <fact> ---
      if (/^add this:/i.test(text)) {
        if (!ADMIN_USERS.includes(userId)) {
          await context.sendActivity(
            MessageFactory.text('Sorry, only admins can add to the knowledge base.')
          );
          await next();
          return;
        }

        const content = text.replace(/^add this:/i, '').trim();

        if (!content) {
          await context.sendActivity(
            MessageFactory.text(
              'Please provide content after "add this:" — e.g. `add this: we never deploy on Fridays`'
            )
          );
          await next();
          return;
        }

        await addKnowledge({ workspaceId, content, addedBy: userId });
        await context.sendActivity(
          MessageFactory.text(`Got it! Added to the team knowledge base:\n\n_"${content}"_`)
        );
        await next();
        return;
      }

      // --- Free-text question → Claude ---
      const facts = await getRelevantFacts(workspaceId);
      const answer = await answerQuestion(text, facts);
      await context.sendActivity(MessageFactory.text(answer));

      await next();
    });

    // Welcome message when someone first chats with the bot
    this.onMembersAdded(async (context, next) => {
      for (const member of context.activity.membersAdded) {
        if (member.id !== context.activity.recipient.id) {
          await context.sendActivity(
            MessageFactory.text(
              "Hi! I'm your **Teammate Bot** — I know how your company actually works.\n\n" +
                '• Type `info` to see all team knowledge\n' +
                '• Ask me anything and I\'ll answer from the knowledge base\n' +
                '• Admins: add facts by typing `add this: <fact>`'
            )
          );
        }
      }
      await next();
    });
  }
}
