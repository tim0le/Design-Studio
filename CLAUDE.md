# Furgoson Studio App — Claude Instructions

This is the **studio-app**: an Express UI wrapping the Marp-based Furgoson deck builder. The actual decks, theme, and build pipeline live in a sibling repo at `../furgoson-studio/`.

## What this app does

- Serves the studio frontend at `/` (deck list, slide viewer, edit chat panel).
- Reads/writes deck markdown in `../furgoson-studio/decks/`.
- Renders slides on demand via Marp (`lib/marp.js`).
- Exposes two editing paths: a legacy quick-edit and a Claude Code agent.

## Agent integration (the new path)

`POST /api/agent/edit` streams Claude Code agent events as Server-Sent Events. The frontend opens the stream, displays tool calls and assistant chunks live, and reloads the slide iframe when the stream closes.

Where to look:

- `lib/agentSystemPrompt.js` — builds the long system prompt the agent runs under (positioning, design tokens, editing rules, workflow). Exports `buildSystemPrompt({deckId, slideIndex, elementText, elementHtml, slideMarkdown})`.
- `lib/agent.js` — SDK wrapper that spawns the agent with that system prompt and the studio repo as `cwd`.
- `routes/agent.js` — HTTP layer that turns SDK events into SSE.
- `public/agent.js` — frontend that consumes the SSE stream.

The agent works inside `../furgoson-studio/`, NOT inside this studio-app repo. Edits land in deck files outside this tree, so don't expect `git status` here to show deck changes.

## Legacy quick-edit path (do not extend)

- `lib/claude.js` — direct Anthropic SDK call, single-shot text replacement.
- `routes/edit.js` — one-message edit endpoint with fuzzy text matching.
- `routes/move.js` — slide reordering.

These work and stay for fallback, but **do not add new behavior here**. New features go through the agent path.

## Other files

- `lib/deck.js` — deck file parsing (frontmatter + slide split on `---`).
- `lib/marp.js` — wraps the Marp CLI for single-slide rendering.
- `routes/decks.js`, `routes/render.js`, `routes/export.js` — read-only deck APIs and export.

## Running

```powershell
npm install
npm start   # http://localhost:3000
```

Requires `ANTHROPIC_API_KEY` in `.env` (copy from `.env.template`).

## Design rules

The agent enforces the design system (tokens, fonts, no inline styles) via its system prompt — see `lib/agentSystemPrompt.js`. The studio repo's own `../furgoson-studio/CLAUDE.md` is the canonical source for those rules; this app just forwards them into the agent's context.
