import express from 'express';
import { BotFrameworkAdapter } from 'botbuilder';
import { TeammateBot } from '../bot/teamsBot.js';

const adapter = new BotFrameworkAdapter({
  appId: process.env.MICROSOFT_APP_ID,
  appPassword: process.env.MICROSOFT_APP_PASSWORD,
});

adapter.onTurnError = async (context, error) => {
  console.error('[onTurnError]', error);
  await context.sendActivity('Something went wrong. Please try again.');
};

const bot = new TeammateBot();

const app = express();
app.use(express.json());

// Teams sends all bot messages here
app.post('/api/messages', async (req, res) => {
  await adapter.processActivity(req, res, async (context) => {
    await bot.run(context);
  });
});

// Health check — useful for Railway/Render uptime monitoring
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

export default app;
