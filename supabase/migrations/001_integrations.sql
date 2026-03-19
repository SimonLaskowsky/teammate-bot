-- Add source_id to knowledge for integration deduplication
alter table knowledge add column if not exists source_id text;

create unique index if not exists knowledge_workspace_source_id
  on knowledge(workspace_id, source_id)
  where source_id is not null;

-- Integrations table — stores encrypted tokens + config per workspace
create table if not exists integrations (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null,
  type text not null,         -- 'github', 'clickup', etc.
  token_enc text,             -- AES-256-GCM encrypted token
  config jsonb default '{}',  -- { repos: [...], channels: [...], etc. }
  active boolean default true,
  created_at timestamptz default now(),
  unique(workspace_id, type)
);

-- Permissions
grant all on table integrations to anon, authenticated, service_role;
