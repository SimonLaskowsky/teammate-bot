create table if not exists conversations (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null,
  user_id text not null,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  created_at timestamptz default now()
);

create index if not exists conversations_user_idx
  on conversations(workspace_id, user_id, created_at desc);

grant all on table conversations to anon, authenticated, service_role;
