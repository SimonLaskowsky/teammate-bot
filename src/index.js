import 'dotenv/config';

// @slack/socket-mode has a known bug where Slack's periodic "server explicit disconnect"
// (connection rotation) crashes the process if it arrives during reconnection.
// We catch it here so Railway can restart cleanly instead of looping on crashes.
process.on('uncaughtException', (err) => {
  if (err.message?.includes('server explicit disconnect')) {
    console.warn('[warn] Slack sent a server explicit disconnect — restarting process.');
    process.exit(1);
  }
  throw err;
});

const platform = process.env.PLATFORM ?? 'slack';

if (platform === 'slack') {
  const { createSlackApp } = await import('./platforms/slack/index.js');
  const app = createSlackApp();
  await app.start();
  console.log('Teammate Bot running on Slack (Socket Mode)');
} else if (platform === 'teams') {
  const { createTeamsApp } = await import('./platforms/teams/index.js');
  const app = createTeamsApp();
  const PORT = process.env.PORT ?? 3000;
  app.listen(PORT, () => console.log(`Teammate Bot running on Teams, port ${PORT}`));
} else {
  console.error(`Unknown PLATFORM="${platform}". Set PLATFORM=slack or PLATFORM=teams in .env`);
  process.exit(1);
}
