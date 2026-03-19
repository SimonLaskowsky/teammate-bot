import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are a helpful team assistant bot embedded in Slack. \
Your job is to answer questions based on your team's knowledge base.

Rules:
- Be concise and friendly — this is a Slack conversation, not a document
- Only answer based on the knowledge base provided; don't invent facts
- If the answer isn't in the knowledge base, say so clearly and suggest who might know or where to look
- Use Slack-friendly formatting (bullet points with -, bold with *bold*)`;

export async function answerQuestion(question, facts) {
  const knowledgeBlock =
    facts.length > 0
      ? facts.map((f) => `- ${f.content}`).join('\n')
      : '(No knowledge base entries yet.)';

  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: `${SYSTEM_PROMPT}\n\nToday is ${today}.\n\n*Team Knowledge Base:*\n${knowledgeBlock}`,
    messages: [{ role: 'user', content: question }],
  });

  return message.content[0].text;
}
