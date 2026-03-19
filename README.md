# Teammate Bot

An AI bot that lives in Microsoft Teams and acts like a knowledgeable team member. Ask it anything about how your company actually works.

## What it does

- **`info`** — shows all pinned team facts
- **Ask anything** — message the bot directly or @mention it in a channel; it answers using your knowledge base + Claude
- **`add this: <fact>`** — admins can add new facts by messaging the bot

## Setup (~10 minutes)

### 1. Register your bot (Teams Developer Portal — no Azure Portal needed)

1. Go to [Teams Developer Portal](https://dev.teams.microsoft.com) → **Apps** → **New app**
2. Fill in a name (e.g. "Teammate") and click **Add**
3. In the left menu → **App features** → **Bot** → **Create a new bot**
4. Give it a name → **Add** — you'll land on the bot configuration page
5. Copy the **Bot ID** → this is your `MICROSOFT_APP_ID`
6. Click **Client secrets** → **Add a client secret** → copy the value → `MICROSOFT_APP_PASSWORD`
7. Set **Endpoint address** to your ngrok URL (next step): `https://<your-ngrok>.ngrok-free.app/api/messages`

That's it — no Azure Portal, no subscription, no resource groups.

### 2. Expose your local server with ngrok

```bash
# Install ngrok: https://ngrok.com/download
ngrok http 3000
```

Paste the `https://` URL (+ `/api/messages`) into the bot's **Endpoint address** in Developer Portal.

> **Tip:** For a permanent URL, deploy to Railway or Render and update the endpoint there (see Deployment section).

### 3. Set up Supabase

1. Create a project at https://supabase.com
2. Go to **SQL Editor** and run the contents of `supabase/schema.sql`
3. Copy your **Project URL** and **service_role key** from Settings → API

### 4. Configure environment

```bash
cp .env.example .env
# Fill in all values
```

### 5. Find your Teams user ID (for admin setup)

Set `DEBUG=true` in `.env`, start the bot, then send it any message. Your `from.id` will be logged in the terminal. Copy it into `ADMIN_USERS`.

### 6. Run the bot

```bash
npm install
npm run dev
```

### 7. Add the bot to Teams

**Option A — via Developer Portal (simplest):**
1. Still in Developer Portal → your app → **Publish** → **Publish to your org** (or **Preview in Teams** to test first)

**Option B — manual sideload (if IT hasn't enabled org publishing):**
1. Edit `teams-app/manifest.json` — replace both `REPLACE_WITH_MICROSOFT_APP_ID` with your App ID
2. Add two icons to `teams-app/`: `color.png` (192×192 px) and `outline.png` (32×32 px)
3. Zip them: `zip teammate-app.zip manifest.json color.png outline.png`
4. In Teams → Apps → **Manage your apps** → **Upload an app** → select the zip

## Usage

**Add knowledge (admin only):**
```
add this: we never deploy on Fridays
add this: fill your hours in ClickUp by Friday or the PM can't report
add this: staging credentials are in the shared drive, ask John for access
add this: client X is sensitive — always CC the account manager
```

**Ask questions (anyone):**
```
how do I request a day off?
who do I talk to about getting access to staging?
what's our git branching strategy?
```

**See all facts:**
```
info
```

## Deployment (when you're ready to go permanent)

### Railway (recommended)

```bash
# Install Railway CLI
npm install -g @railway/cli
railway login
railway init
railway up
```

Set all env vars in Railway dashboard, then update the Azure Bot messaging endpoint to your Railway URL.

## Project structure

```
src/
├── index.js          # Entry point — starts Express server
├── api/
│   └── server.js     # Express + BotFrameworkAdapter — receives Teams webhooks
├── bot/
│   └── teamsBot.js   # Teams activity handler (messages, commands)
├── knowledge/
│   └── store.js      # Knowledge CRUD (Supabase)
└── ai/
    └── claude.js     # Claude API integration
teams-app/
└── manifest.json     # Teams app package (sideload into Teams)
supabase/
└── schema.sql        # DB schema — run once in Supabase SQL editor
```

## Roadmap

- **Phase 2:** Semantic search with pgvector (embeddings already in schema)
- **Phase 2:** Index specific Teams channels (curated, opted-in channels only)
- **Phase 2:** GitHub integration (index READMEs, wikis)
- **Phase 3:** Slack support
- **Phase 3:** Notion / Confluence integration
