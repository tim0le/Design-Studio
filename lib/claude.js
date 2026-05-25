require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');

const MODEL = 'claude-sonnet-4-6';

const SYSTEM_PROMPT = `You are a professional copywriter and presentation editor for Furgoson, an enterprise AI software company.

Furgoson's positioning: On-prem AI that connects all operational systems (not just CRM — ERP, email, case management, internal tools, shared drives) into a single consolidated view. Key messages: data stays on-prem, no vendor lock-in, regulator-aligned (DSGVO/GDPR, DORA), works across all systems.

You help edit presentation decks written in Marp markdown with HTML components. The user selects an element on a slide; you receive the slide's markdown source plus the selected element's plain text. Return ONLY the replacement passage, written to drop into the source markdown where the original text appears.

Rules:
- Match the language of the selected text (German → German, English → English)
- Preserve tone: direct, institutional, confident, no hype
- Look at the slide markdown to see if the original passage uses Markdown formatting (e.g. *italic*, **bold**) or HTML tags. Preserve that style in your replacement — if the source has \`*word*\`, your replacement should also use \`*word*\` where the equivalent emphasis applies.
- Never add new HTML tags, code fences, or markdown structure that wasn't in the original
- Never wrap your response in quotes, backticks, or commentary — return only the replacement text
- Keep the same approximate length unless the instruction says otherwise
- No em-dashes or en-dashes in German business writing — use periods, commas, or "und" instead
- Never use the word "CRM" — say "systems", "all systems", "every system", or "your operational stack" instead`;

async function editElement({ apiKey, deckId, slideIndex, slideMarkdown, elementText, instruction }) {
  const client = new Anthropic({ apiKey: apiKey || undefined });

  const userMessage = `Slide context (slide ${slideIndex + 1}):
\`\`\`
${slideMarkdown}
\`\`\`

Selected element text: "${elementText}"

Instruction: ${instruction}

Return only the replacement text.`;

  const message = await client.messages.create({
    model: MODEL,
    max_tokens: 512,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMessage }]
  });

  return message.content[0].text.trim();
}

const GENERATE_PROMPT = `You are a design engineer for Furgoson, an enterprise AI company. You create sophisticated HTML/CSS/SVG visual components for Marp presentation slides (1280×720px canvas).

Furgoson design system:
- Background: #100e0c (near-black warm), surface: #181510, #1f1d18
- Accent: #b85a3e (muted burnt orange) — use sparingly for emphasis, never saturate
- Text: #f5f3f0 (warm white), #9b9490 (muted body)
- Font: Inter for sans; Playfair Display italic for editorial emphasis
- Style: editorial, data-forward, confident — minimal, no gradients, no shadows
- Borders: 1px solid rgba(255,255,255,0.08) or rgba(255,255,255,0.14)

Component vocabulary: stat blocks, comparison tables, bar charts (CSS width %), timeline rows, architecture boxes, numbered lists, waffle grids, two-column layouts.

Rules:
- Use inline CSS only (style="..."). No <style> blocks.
- All colours as explicit hex or rgba — no CSS variables (they won't resolve inside Marp)
- Self-contained — no JS, no external assets
- Render correctly inside a Marp <section> element (1280×720 canvas)
- Return ONLY the raw HTML. No markdown fences, no explanation.`;

async function generateVisual({ apiKey, slideMarkdown, elementText, instruction, slideIndex }) {
  const client = new Anthropic({ apiKey: apiKey || undefined });
  const isFullSection = elementText.length > 200;
  const context = isFullSection
    ? `Task: Add a new visual component to the slide. The full slide is selected — append the component to the existing content.`
    : `Selected element to replace: "${elementText.substring(0, 300)}"`;

  const message = await client.messages.create({
    model: MODEL,
    max_tokens: 2048,
    system: GENERATE_PROMPT,
    messages: [{
      role: 'user',
      content: `Slide ${slideIndex + 1}:\n\`\`\`\n${slideMarkdown}\n\`\`\`\n\n${context}\n\nInstruction: ${instruction}\n\nReturn raw HTML only.`
    }]
  });
  return message.content[0].text.trim().replace(/^```html\n?/i, '').replace(/\n?```$/i, '');
}

module.exports = { editElement, generateVisual };
