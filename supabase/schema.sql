-- Enable pgvector extension (for Phase 2 semantic search)
create extension if not exists vector;

-- Knowledge entries
create table if not exists knowledge (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null,
  content text not null,
  source text default 'manual',   -- 'manual', 'slack', 'github', etc.
  added_by text,                  -- Slack user ID of who added it
  tags text[] default '{}',
  embedding vector(1536),         -- populated in Phase 2
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Index for fast workspace filtering
create index if not exists knowledge_workspace_id_idx on knowledge (workspace_id);

-- Full-text search index (used in MVP search)
create index if not exists knowledge_content_fts on knowledge
  using gin(to_tsvector('english', content));

-- Workspace config (tokens, admin list, settings)
create table if not exists workspaces (
  id text primary key,
  platform text default 'slack',  -- 'slack' or 'teams'
  slack_token_enc text,           -- encrypted bot token (Phase 2 multi-workspace)
  github_token_enc text,
  indexed_channels text[] default '{}',
  admin_users text[] default '{}',
  created_at timestamptz default now()
);

-- Auto-update updated_at on knowledge edits
create or replace function update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create or replace trigger knowledge_updated_at
  before update on knowledge
  for each row execute function update_updated_at();
