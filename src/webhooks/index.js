import express from 'express';
import { handleGithubWebhook } from './github.js';
import { handleClickupWebhook } from './clickup.js';

export function startWebhookServer() {
  const PORT = process.env.PORT ?? 3000;

  if (!process.env.PUBLIC_URL) {
    console.warn('[webhooks] PUBLIC_URL not set — webhooks disabled. Set it to your Railway public URL.');
  }

  const app = express();

  // Capture raw body for GitHub HMAC signature verification
  app.use(express.json({
    verify: (req, res, buf) => { req.rawBody = buf; },
  }));

  app.post('/webhooks/github', handleGithubWebhook);
  app.post('/webhooks/clickup/:workspaceId/:token', handleClickupWebhook);

  app.get('/health', (req, res) => res.send('ok'));

  app.listen(PORT, '0.0.0.0', () => console.log(`[webhooks] HTTP server listening on port ${PORT}`));
}
