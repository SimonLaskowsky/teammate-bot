import { createClient } from '@supabase/supabase-js';
import { embed } from '../ai/embeddings.js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── Workspaces ────────────────────────────────────────────────────────────────

export async function ensureWorkspace(workspaceId, platform = 'slack') {
  const { data } = await supabase.from('workspaces').select('id').eq('id', workspaceId).single();
  if (!data) await supabase.from('workspaces').insert({ id: workspaceId, platform });
}

// ── Knowledge entries ─────────────────────────────────────────────────────────

export async function addKnowledge({ workspaceId, content, addedBy, source = 'manual', tags = [] }) {
  const embedding = await embed(content).catch(() => null);
  const { data, error } = await supabase
    .from('knowledge')
    .insert({ workspace_id: workspaceId, content, source, added_by: addedBy, tags, embedding })
    .select()
    .single();
  if (error) throw error;
  return data;
}

// Upsert by source_id — used by integrations to avoid duplicates on re-sync
export async function upsertKnowledge({ workspaceId, content, source, sourceId, addedBy }) {
  const embedding = await embed(content).catch(() => null);
  const { error } = await supabase.from('knowledge').upsert(
    { workspace_id: workspaceId, content, source, source_id: sourceId, added_by: addedBy, embedding },
    { onConflict: 'workspace_id,source_id' }
  );
  if (error) throw error;
}

export async function getManualFacts(workspaceId) {
  const { data, error } = await supabase
    .from('knowledge')
    .select('content')
    .eq('workspace_id', workspaceId)
    .eq('source', 'manual')
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data ?? []).map((r) => r.content);
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

export async function getKnowledgeCounts(workspaceId) {
  const { data, error } = await supabase
    .from('knowledge')
    .select('source')
    .eq('workspace_id', workspaceId);
  if (error) throw error;
  const counts = {};
  for (const row of data ?? []) {
    counts[row.source] = (counts[row.source] ?? 0) + 1;
  }
  return counts;
}

export async function deleteKnowledge(workspaceId, sourceId) {
  const { error } = await supabase
    .from('knowledge')
    .delete()
    .eq('workspace_id', workspaceId)
    .eq('source_id', sourceId);
  if (error) throw error;
}

export async function getRelevantFacts(workspaceId, question) {
  try {
    const embedding = await embed(question);
    const { data, error } = await supabase.rpc('search_knowledge', {
      query_embedding: embedding,
      p_workspace_id: workspaceId,
      p_match_count: 10,
    });
    if (error) throw error;
    if (data?.length) return data;
  } catch (err) {
    console.error('[getRelevantFacts] vector search failed, falling back:', err.message);
  }
  return getAllFacts(workspaceId);
}

// ── Conversation history ──────────────────────────────────────────────────────

export async function saveMessage(workspaceId, userId, role, content) {
  const { error } = await supabase
    .from('conversations')
    .insert({ workspace_id: workspaceId, user_id: userId, role, content });
  if (error) throw error;
}

export async function getRecentMessages(workspaceId, userId, limit = 12) {
  const { data, error } = await supabase
    .from('conversations')
    .select('role, content')
    .eq('workspace_id', workspaceId)
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []).reverse(); // return in chronological order
}

// ── Integrations ──────────────────────────────────────────────────────────────

export async function saveIntegration(workspaceId, type, tokenEnc, config = {}) {
  const { error } = await supabase
    .from('integrations')
    .upsert(
      { workspace_id: workspaceId, type, token_enc: tokenEnc, config, active: true },
      { onConflict: 'workspace_id,type' }
    );
  if (error) throw error;
}

export async function getIntegration(workspaceId, type) {
  const { data, error } = await supabase
    .from('integrations')
    .select('*')
    .eq('workspace_id', workspaceId)
    .eq('type', type)
    .eq('active', true)
    .single();
  if (error && error.code !== 'PGRST116') throw error; // PGRST116 = not found
  return data ?? null;
}

export async function getActiveIntegrations(workspaceId) {
  const { data, error } = await supabase
    .from('integrations')
    .select('*')
    .eq('workspace_id', workspaceId)
    .eq('active', true);
  if (error) throw error;
  return data ?? [];
}

export async function getAllActiveIntegrations() {
  const { data, error } = await supabase
    .from('integrations')
    .select('*')
    .eq('active', true);
  if (error) throw error;
  return data ?? [];
}

export async function removeIntegration(workspaceId, type) {
  const { error } = await supabase
    .from('integrations')
    .update({ active: false })
    .eq('workspace_id', workspaceId)
    .eq('type', type);
  if (error) throw error;
}
