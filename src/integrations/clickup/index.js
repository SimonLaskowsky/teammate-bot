import { decrypt } from '../../crypto.js';
import { upsertKnowledge } from '../../knowledge/store.js';

export const name = 'clickup';
export const displayName = 'ClickUp';
export const tokenPrompt =
  'Paste your ClickUp Personal API Token.\n' +
  '_(Find it at: ClickUp avatar → Settings → Apps → API Token)_';

const BASE = 'https://api.clickup.com/api/v2';

function headers(token) {
  return { Authorization: token, 'Content-Type': 'application/json' };
}

async function get(path, token) {
  const res = await fetch(`${BASE}${path}`, { headers: headers(token) });
  return res.ok ? res.json() : null;
}

export async function validate(token) {
  const data = await get('/user', token);
  return !!data?.user;
}

export async function listItems(token) {
  const data = await get('/team', token);
  const items = (data?.teams ?? []).map((t) => ({ id: t.id, name: t.name }));
  return { items, label: 'workspaces' };
}

export function buildConfig(selectedItems) {
  return { workspaces: selectedItems };
}

export function configSummary(config) {
  return `workspaces: ${config.workspaces?.map((w) => w.name).join(', ') ?? '—'}`;
}

// Fetch all lists in a space (direct lists + lists inside folders)
async function getSpaceLists(spaceId, token) {
  const [listsData, foldersData] = await Promise.all([
    get(`/space/${spaceId}/list?archived=false`, token),
    get(`/space/${spaceId}/folder?archived=false`, token),
  ]);

  const lists = [...(listsData?.lists ?? [])];

  for (const folder of foldersData?.folders ?? []) {
    const folderLists = await get(`/folder/${folder.id}/list?archived=false`, token);
    lists.push(...(folderLists?.lists ?? []));
  }

  return lists;
}

export async function getTimeEntries(teamId, token, { assigneeName, startDate, endDate } = {}) {
  // Resolve assignee name → user ID using /team (same endpoint used during connect)
  let assigneeId;
  if (assigneeName) {
    const teamsData = await get('/team', token);
    const workspace = teamsData?.teams?.find((t) => t.id === teamId);
    const members = workspace?.members ?? [];
    const needle = assigneeName.toLowerCase();
    const match = members.find((m) => {
      const username = (m.user?.username ?? '').toLowerCase();
      const email = (m.user?.email ?? '').toLowerCase();
      return username.includes(needle) || email.split('@')[0].includes(needle);
    });
    if (!match) {
      const names = members.map((m) => m.user?.username ?? m.user?.email).join(', ');
      return `Could not find "${assigneeName}" in ClickUp. Known members: ${names}`;
    }
    assigneeId = match.user.id;
  }

  // Default to last 30 days if no dates provided
  const end = endDate ? new Date(endDate) : new Date();
  const start = startDate ? new Date(startDate) : new Date(end - 30 * 24 * 60 * 60 * 1000);

  const params = new URLSearchParams({
    start_date: start.getTime().toString(),
    end_date: end.getTime().toString(),
    ...(assigneeId ? { assignee: assigneeId } : {}),
  });

  const data = await get(`/team/${teamId}/time_entries?${params}`, token);
  const entries = data?.data ?? [];

  if (entries.length === 0) return 'No time entries found for that filter.';

  // Group by task and sum durations
  const byTask = new Map();
  for (const entry of entries) {
    const taskName = entry.task?.name ?? 'No task';
    const taskId = entry.task?.id ?? 'none';
    const key = taskId;
    if (!byTask.has(key)) byTask.set(key, { name: taskName, ms: 0, user: entry.user?.username });
    byTask.get(key).ms += parseInt(entry.duration ?? 0);
  }

  const totalMs = [...byTask.values()].reduce((sum, t) => sum + t.ms, 0);

  const lines = [...byTask.values()]
    .sort((a, b) => b.ms - a.ms)
    .map((t) => `- ${t.name}: ${formatDuration(t.ms)}`);

  return [
    assigneeName ? `Time tracked by ${assigneeName}:` : 'Time entries:',
    ...lines,
    `\nTotal: ${formatDuration(totalMs)}`,
    `Period: ${start.toISOString().slice(0, 10)} → ${end.toISOString().slice(0, 10)}`,
  ].join('\n');
}

function formatDuration(ms) {
  const totalMinutes = Math.round(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

export async function sync(workspaceId, integration) {
  const token = decrypt(integration.token_enc);
  const workspaces = integration.config.workspaces ?? [];
  let synced = 0;
  const failed = [];

  for (const { id: teamId, name: teamName } of workspaces) {
    try {
      const spacesData = await get(`/team/${teamId}/space?archived=false`, token);

      for (const space of spacesData?.spaces ?? []) {
        const lists = await getSpaceLists(space.id, token);

        for (const list of lists) {
          let page = 0;
          while (true) {
            const tasksData = await get(
              `/list/${list.id}/task?subtasks=true&include_closed=false&page=${page}`,
              token
            );
            const tasks = tasksData?.tasks ?? [];
            if (tasks.length === 0) break;

            for (const task of tasks) {
              const assignees = task.assignees?.map((a) => a.username).join(', ') || 'unassigned';
              const due = task.due_date
                ? new Date(parseInt(task.due_date)).toISOString().slice(0, 10)
                : 'no due date';
              const desc = task.description?.slice(0, 300) ?? '';

              await upsertKnowledge({
                workspaceId,
                content: [
                  `[ClickUp] ${task.name}`,
                  `Status: ${task.status?.status ?? 'unknown'} | Priority: ${task.priority?.priority ?? 'none'} | Assignee: ${assignees} | Due: ${due}`,
                  `Space: ${space.name} > List: ${list.name}`,
                  desc ? `Description: ${desc}` : '',
                ].filter(Boolean).join('\n'),
                source: 'clickup',
                sourceId: `clickup:task:${task.id}`,
                addedBy: 'clickup-integration',
              });
              synced++;
            }

            if (tasks.length < 100) break;
            page++;
          }
        }
      }
    } catch (err) {
      console.error(`[clickup] Failed to sync workspace ${teamId}:`, err.message);
      failed.push(`${teamName} (${err.message})`);
    }
  }

  return { synced, failed };
}
