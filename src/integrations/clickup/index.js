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
