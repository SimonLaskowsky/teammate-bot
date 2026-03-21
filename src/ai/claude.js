import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are a helpful team assistant bot embedded in Slack.
Answer questions about the team, projects, and company.

Rules:
- Always call search_knowledge first before answering — it searches the team knowledge base
- If the user asks about a specific commit's changes, call github_get_commit to fetch the details
- Be concise — this is Slack, not a document
- When facts conflict, prefer the most recent one
- If you can't find the answer after searching, say so clearly

Slack formatting — STRICTLY follow these rules, no exceptions:
- Section headers: use *Header* on its own line (NOT ## or ### — those don't render in Slack)
- Bold: *text* (NOT **text**)
- Italic: _text_
- Lists: start lines with - or •
- NO horizontal rules (--- does not render)
- NO markdown tables (| col | — not supported in Slack)
- NO HTML
- Code/commands: use \`backticks\``;

const TOOLS = [
  {
    name: 'search_knowledge',
    description: 'Search the team knowledge base for relevant information. Always call this first.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to search for' },
      },
      required: ['query'],
    },
  },
  {
    name: 'github_get_commit',
    description: 'Fetch details of a specific GitHub commit: files changed, author, message.',
    input_schema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Full repo name e.g. SimonLaskowsky/mapa-cen-mieszkan' },
        sha: { type: 'string', description: 'Commit SHA (full or short, e.g. abc1234)' },
      },
      required: ['repo', 'sha'],
    },
  },
  {
    name: 'clickup_get_time_entries',
    description: 'Fetch time tracked in ClickUp. Can filter by person name and/or date range.',
    input_schema: {
      type: 'object',
      properties: {
        assignee_name: { type: 'string', description: 'Name of the person to filter by (optional)' },
        start_date: { type: 'string', description: 'Start date YYYY-MM-DD (optional, defaults to 30 days ago)' },
        end_date: { type: 'string', description: 'End date YYYY-MM-DD (optional, defaults to today)' },
      },
    },
  },
];

const STATUS_LABELS = {
  search_knowledge: (input) => `Searching knowledge base for _"${input.query}"_...`,
  github_get_commit: (input) => `Fetching commit \`${input.sha}\` from GitHub...`,
  clickup_get_time_entries: (input) => `Fetching time entries from ClickUp${input.assignee_name ? ` for ${input.assignee_name}` : ''}...`,
};

export async function answerQuestion(question, history = [], channelHistory = [], { onStatus, toolHandlers = {} } = {}) {
  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  let system = `${SYSTEM_PROMPT}\n\nToday is ${today}.`;
  if (channelHistory.length > 0) {
    system += `\n\n*Recent channel conversation (live context):*\n${channelHistory.join('\n')}`;
  }

  const messages = [...history, { role: 'user', content: question }];

  // Agentic loop — Claude calls tools until it has enough to answer (max 6 rounds)
  for (let i = 0; i < 6; i++) {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
      system,
      tools: TOOLS,
      messages,
    });

    if (response.stop_reason === 'end_turn') {
      return response.content.find((b) => b.type === 'text')?.text ?? '';
    }

    if (response.stop_reason === 'tool_use') {
      messages.push({ role: 'assistant', content: response.content });

      const toolResults = [];
      for (const block of response.content.filter((b) => b.type === 'tool_use')) {
        const handler = toolHandlers[block.name];
        let result = 'Tool not available.';

        if (onStatus) await onStatus(STATUS_LABELS[block.name]?.(block.input) ?? `Running ${block.name}...`);

        if (handler) {
          try {
            result = await handler(block.input);
          } catch (err) {
            result = `Error: ${err.message}`;
          }
        }

        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: String(result) });
      }

      messages.push({ role: 'user', content: toolResults });
    }
  }

  return 'Sorry, I ran into an issue finding that information.';
}
