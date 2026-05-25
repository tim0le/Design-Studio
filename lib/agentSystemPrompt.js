// STUB — Unit 5 will replace this with the real Furgoson design-system prompt.
// Unit 1 only needs the export to be callable so lib/agent.js can be imported
// without runtime errors.
function buildSystemPrompt({ deckId, slideIndex, elementText, elementHtml, slideMarkdown }) {
  return [
    'You are a slide-editing agent for the Furgoson Studio (Marp-based decks).',
    `Working on deck \`${deckId}\`, slide index ${slideIndex}.`,
    'Use Read/Edit/Glob/Grep/Bash to edit the deck markdown surgically.',
    'When the edit is done, summarise what changed in plain language.',
  ].join('\n');
}

module.exports = { buildSystemPrompt };
