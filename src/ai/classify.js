import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const CATEGORIES = ['technical', 'process', 'project', 'people', 'social'];

// Source-based defaults — no LLM call needed
const SOURCE_DEFAULTS = {
  github: 'technical',
  clickup: 'project',
};

export async function classifyContent(content, source) {
  if (SOURCE_DEFAULTS[source]) return SOURCE_DEFAULTS[source];

  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 10,
      messages: [{
        role: 'user',
        content:
          'Classify this team message into exactly one category.\n\n' +
          'Categories:\n' +
          '- technical: code, bugs, architecture, tools, PRs, deployments, libraries\n' +
          '- process: how we work, rules, conventions, workflows, agreements\n' +
          '- project: project updates, milestones, status, deadlines, features\n' +
          '- people: team members, personalities, roles, reputation, skills, who does what\n' +
          '- social: casual chat, humor, food, events, non-work talk\n\n' +
          `Message: "${content.slice(0, 500)}"\n\n` +
          'Reply with just one word (the category name).',
      }],
    });
    const category = response.content[0]?.text?.trim().toLowerCase();
    return CATEGORIES.includes(category) ? category : 'social';
  } catch {
    return 'social';
  }
}
