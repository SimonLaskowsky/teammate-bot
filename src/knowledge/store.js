import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

export async function ensureWorkspace(workspaceId, platform = 'slack') {
  const { data } = await supabase
    .from('workspaces')
    .select('id')
    .eq('id', workspaceId)
    .single();

  if (!data) {
    await supabase.from('workspaces').insert({ id: workspaceId, platform });
  }
}

export async function addKnowledge({ workspaceId, content, addedBy, source = 'manual', tags = [] }) {
  const { data, error } = await supabase
    .from('knowledge')
    .insert({ workspace_id: workspaceId, content, source, added_by: addedBy, tags })
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function getAllFacts(workspaceId) {
  const { data, error } = await supabase
    .from('knowledge')
    .select('content, source, added_by, created_at')
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: false });

  if (error) throw error;
  return data ?? [];
}

// For MVP: retrieve all facts and let Claude determine relevance.
// Phase 2: replace with pgvector similarity search.
export async function getRelevantFacts(workspaceId) {
  return getAllFacts(workspaceId);
}
