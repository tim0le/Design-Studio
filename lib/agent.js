const path = require('path');
const { buildSystemPrompt } = require('./agentSystemPrompt');
const { readDeck } = require('./deck');

// The Claude Agent SDK is ESM-only; this app is CommonJS. Cache the dynamic
// import promise so we pay the load cost once per process.
let _sdkPromise = null;
function loadSdk() {
  if (!_sdkPromise) _sdkPromise = import('@anthropic-ai/claude-agent-sdk');
  return _sdkPromise;
}

// The Marp deck repo lives next to the studio app. The agent edits files in
// this cwd (decks/<deckId>.md). Resolves once at module load.
// FURGOSON_DECK_REPO env var overrides for non-standard layouts (e.g. testing
// from a git worktree that is not one level under the deck repo's parent).
const DECK_REPO_CWD = process.env.FURGOSON_DECK_REPO
  ? path.resolve(process.env.FURGOSON_DECK_REPO)
  : path.resolve(__dirname, '../../furgoson-studio');

/**
 * Run a Claude Code agent session to edit one slide.
 *
 * Returns an async iterator of plain objects matching the SSE event protocol
 * documented in routes/agent.js (Unit 2). The caller iterates with `for await`
 * and forwards each event to the browser.
 *
 * @param {object} params
 * @param {string} params.apiKey            ANTHROPIC_API_KEY for this session
 * @param {string} params.deckId            e.g. 'de/ihk_4pager'
 * @param {number} params.slideIndex        0-based
 * @param {string} [params.elementText]     selected element plain text
 * @param {string} [params.elementHtml]     selected element outerHTML
 * @param {string} params.instruction       user's natural-language ask
 * @param {string} [params.resumeSessionId] continue a previous agent session
 * @param {string} [params.baseURL]         Override Anthropic API base URL
 *                                          (e.g. local LiteLLM proxy). Forwarded
 *                                          to the spawned subprocess via the
 *                                          ANTHROPIC_BASE_URL env var, which the
 *                                          underlying @anthropic-ai/sdk reads.
 * @param {string} [params.model]           Override the model name. Useful when
 *                                          routing to a local server that
 *                                          exposes a non-Claude model id (e.g.
 *                                          'gemma3-27b').
 */
async function* editSlideWithAgent({
  apiKey,
  deckId,
  slideIndex,
  elementText,
  elementHtml,
  instruction,
  resumeSessionId,
  baseURL,
  model,
}) {
  let sessionId = null;

  try {
    const { query } = await loadSdk();

    // Snapshot the slide BEFORE the agent runs so the system/user prompt can
    // include the source the agent will operate on. We read again at the end
    // to produce the `updatedSlideMarkdown` field on the `result` event.
    let beforeSlideMarkdown = '';
    try {
      const { slides } = readDeck(deckId);
      beforeSlideMarkdown = slides[slideIndex] || '';
    } catch (_) {
      // Allow the agent to proceed even if the deck can't be read here — it
      // will fail loudly via the Read tool with a clearer error.
    }

    const systemPrompt = buildSystemPrompt({
      deckId,
      slideIndex,
      elementText,
      elementHtml,
      slideMarkdown: beforeSlideMarkdown,
    });

    const userMessage = buildUserMessage({
      deckId,
      slideIndex,
      elementText,
      elementHtml,
      instruction,
      slideMarkdown: beforeSlideMarkdown,
    });

    // Don't let an undefined apiKey shadow an inherited env var: `{ ...env,
    // KEY: undefined }` puts `undefined` on the object, and child_process may
    // pass that to the subprocess in ways that look like "key unset" or
    // "key=" depending on platform. Only override when caller actually
    // supplied a key; otherwise let the subprocess inherit normally.
    //
    // baseURL is forwarded the same way: the SDK passes our `env` through to
    // the spawned Claude Code subprocess, and the underlying @anthropic-ai/sdk
    // reads ANTHROPIC_BASE_URL when constructing its HTTP client. This keeps
    // the override scoped to this single query() call — no process-global
    // env mutation, so concurrent sessions with different backends don't race.
    const env = { ...process.env };
    if (apiKey) env.ANTHROPIC_API_KEY = apiKey;
    // The browser picker is authoritative: if it didn't pass baseURL, scrub
    // any inherited ANTHROPIC_BASE_URL so the SDK can't silently route an
    // Anthropic-Cloud-intended request to a leftover local proxy URL.
    if (baseURL) env.ANTHROPIC_BASE_URL = baseURL;
    else         delete env.ANTHROPIC_BASE_URL;

    // Path guard for tool writes. The agent should ONLY be able to mutate the
    // single deck file at `decks/<deckId>.md`. The system prompt asks for this
    // but a misaligned model (e.g. when routed to a local Gemma/Nemotron) will
    // happily Edit theme/furgoson.css and recolor every slide of every deck.
    // canUseTool is the SDK's per-call permission hook — last line of defense.
    const targetDeckRel = path.posix.join('decks', `${deckId}.md`);
    const targetDeckAbs = path.resolve(DECK_REPO_CWD, 'decks', `${deckId}.md`);

    function pathIsTargetDeck(rawPath) {
      if (!rawPath || typeof rawPath !== 'string') return false;
      const abs = path.isAbsolute(rawPath)
        ? path.resolve(rawPath)
        : path.resolve(DECK_REPO_CWD, rawPath);
      return path.normalize(abs).toLowerCase() === path.normalize(targetDeckAbs).toLowerCase();
    }

    const canUseTool = async (toolName, input) => {
      // Read / Glob / Grep — always safe (no mutation).
      if (toolName === 'Read' || toolName === 'Glob' || toolName === 'Grep') {
        return { behavior: 'allow', updatedInput: input };
      }
      // Edit / Write — must target the active deck file. Anything else (theme,
      // other decks, assets, settings) is denied with a message that nudges
      // the agent toward Marp's per-slide directive instead.
      if (toolName === 'Edit' || toolName === 'Write' || toolName === 'MultiEdit') {
        const target = input && (input.file_path || input.filePath || input.path);
        if (pathIsTargetDeck(target)) {
          return { behavior: 'allow', updatedInput: input };
        }
        return {
          behavior: 'deny',
          message:
            `Permission denied: ${toolName} on "${target}". You may only edit ` +
            `the active deck file "${targetDeckRel}". For per-slide style ` +
            `changes use a Marp directive in the slide itself (e.g. ` +
            `\`<!-- _backgroundColor: "#1f4fff" -->\`). Do NOT edit ` +
            `theme/furgoson.css — it is global and would affect every slide ` +
            `of every deck.`,
        };
      }
      // Bash — allow but reject in-place mutations of forbidden files via
      // common edit utilities. Reads, renders, and grep are fine.
      if (toolName === 'Bash') {
        const cmd = (input && (input.command || input.script || '')) || '';
        const lower = String(cmd).toLowerCase();
        const forbidden = ['theme/furgoson.css'];
        const looksLikeWrite = />\s*[^>]|>>|sed\s+-i|tee\s+|cp\s+[^|]*\s+(?:theme|decks)\b|mv\s+[^|]*\s+(?:theme|decks)\b/.test(lower);
        if (looksLikeWrite && forbidden.some(f => lower.includes(f))) {
          return {
            behavior: 'deny',
            message:
              'Permission denied: Bash command appears to write to ' +
              'theme/furgoson.css. The theme is read-only for this session. ' +
              'Use the Edit tool on the deck file with a Marp `_backgroundColor` directive instead.',
          };
        }
        return { behavior: 'allow', updatedInput: input };
      }
      // Unknown tool — be conservative.
      return {
        behavior: 'deny',
        message: `Tool "${toolName}" is not allowed in this session.`,
      };
    };

    const options = {
      cwd: DECK_REPO_CWD,
      allowedTools: ['Read', 'Edit', 'Glob', 'Grep', 'Bash'],
      // `default` permission mode + canUseTool gives us programmatic control
      // over every tool call. bypassPermissions would skip canUseTool entirely.
      permissionMode: 'default',
      canUseTool,
      systemPrompt,
      env,
    };
    if (resumeSessionId) options.resume = resumeSessionId;
    if (model) options.model = model;

    const iter = query({ prompt: userMessage, options });

    for await (const msg of iter) {
      // System init — first message in every session.
      if (msg.type === 'system' && msg.subtype === 'init') {
        sessionId = msg.session_id;
        yield { type: 'start', sessionId, deckId, slideIndex };
        continue;
      }

      // Assistant — fan out one event per content block so the UI can render
      // text and tool_use independently as they stream in.
      if (msg.type === 'assistant' && msg.message && Array.isArray(msg.message.content)) {
        for (const block of msg.message.content) {
          if (block.type === 'text' && block.text) {
            yield { type: 'assistant_text', text: block.text };
          } else if (block.type === 'tool_use') {
            yield {
              type: 'tool_use',
              id: block.id,
              name: block.name,
              input: block.input,
            };
          }
        }
        // Token usage rides on the assistant message; surface it for the meter.
        const usage = msg.message.usage;
        if (usage) {
          yield {
            type: 'usage',
            inputTokens: usage.input_tokens || 0,
            outputTokens: usage.output_tokens || 0,
            cacheReadTokens: usage.cache_read_input_tokens || 0,
          };
        }
        continue;
      }

      // User messages from the SDK carry tool_result blocks the runtime
      // produced after a tool ran. We don't surface synthetic/non-tool user
      // messages — the UI doesn't need to see the echoed first prompt.
      if (msg.type === 'user' && msg.message) {
        const content = msg.message.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'tool_result') {
              yield {
                type: 'tool_result',
                toolUseId: block.tool_use_id,
                content: block.content,
                isError: block.is_error === true,
              };
            }
          }
        }
        continue;
      }

      // Final result — read the deck back to surface the updated slide.
      if (msg.type === 'result') {
        if (msg.subtype === 'success' || !msg.is_error) {
          let updatedSlideMarkdown = '';
          try {
            const { slides } = readDeck(deckId);
            updatedSlideMarkdown = slides[slideIndex] || '';
          } catch (e) {
            // If reading fails post-edit, propagate as a soft error rather
            // than silently shipping an empty slide.
            yield { type: 'error', message: `Could not re-read deck after edit: ${e.message}` };
            return;
          }
          yield {
            type: 'result',
            summary: msg.result || '',
            updatedSlideMarkdown,
          };
        } else {
          const errors = Array.isArray(msg.errors) ? msg.errors.join('; ') : '';
          yield {
            type: 'error',
            message: `Agent terminated: ${msg.subtype}${errors ? ` — ${errors}` : ''}`,
          };
        }
        return;
      }
    }
  } catch (err) {
    yield { type: 'error', message: err && err.message ? err.message : String(err) };
  }
}

// The user-turn prompt. System prompt carries design-system rules (Unit 5);
// this carries the per-edit context the agent needs to act.
function buildUserMessage({ deckId, slideIndex, elementText, elementHtml, instruction, slideMarkdown }) {
  const lines = [
    `Deck file: decks/${deckId}.md`,
    `Slide index: ${slideIndex} (0-based)`,
  ];
  if (elementText && elementText.trim()) {
    lines.push(`Selected element text: ${JSON.stringify(elementText)}`);
  } else {
    lines.push('Selected element: (none — whole-slide edit)');
  }
  if (elementHtml && elementHtml.trim()) {
    lines.push(`Selected element HTML: ${JSON.stringify(elementHtml)}`);
  }
  if (slideMarkdown) {
    lines.push('', 'Current slide markdown source:', '```markdown', slideMarkdown, '```');
  }
  lines.push('', `Instruction: ${instruction}`);
  lines.push(
    '',
    'Open the deck file with Read, locate the slide, make the surgical Edit, then briefly describe what changed.',
  );
  return lines.join('\n');
}

module.exports = { editSlideWithAgent };
