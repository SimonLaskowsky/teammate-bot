import express from 'express';
import { BotFrameworkAdapter, ActivityHandler, MessageFactory } from 'botbuilder';
import { handleMessage } from '../../handler.js';

const ADMIN_USERS = process.env.ADMIN_USERS?.split(',').map((u) => u.trim()) ?? [];

class TeammateBot extends ActivityHandler {
  constructor() {
    super();

    this.onMessage(async (context, next) => {
      const text = context.activity.text?.replace(/<at>[^<]*<\/at>/g, '').trim();
      const userId = context.activity.from.id;
      const workspaceId = context.activity.conversation.tenantId ?? context.activity.channelData?.team?.id;

      if (!text || !workspaceId) { await next(); return; }

      await handleMessage({
        text,
        userId,
        workspaceId,
        platform: 'teams',
        isAdmin: ADMIN_USERS.includes(userId),
        reply: async (msg) => context.sendActivity(MessageFactory.text(msg)),
      });

      await next();
    });

    this.onMembersAdded(async (context, next) => {
      for (const member of context.activity.membersAdded) {
        if (member.id !== context.activity.recipient.id) {
          await context.sendActivity(MessageFactory.text("Hi! I'm Teammate. Type `help` to see what I can do."));
        }
      }
      await next();
    });
  }
}

export function createTeamsApp() {
  const adapter = new BotFrameworkAdapter({
    appId: process.env.MICROSOFT_APP_ID,
    appPassword: process.env.MICROSOFT_APP_PASSWORD,
  });

  adapter.onTurnError = async (context, error) => {
    console.error('Teams error:', error);
    await context.sendActivity('Something went wrong. Please try again.');
  };

  const bot = new TeammateBot();
  const app = express();
  app.use(express.json());

  app.post('/api/messages', async (req, res) => {
    await adapter.processActivity(req, res, async (context) => bot.run(context));
  });

  app.get('/health', (_req, res) => res.json({ status: 'ok' }));

  return app;
}
