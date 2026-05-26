# Local LLM routing

The studio's agent path normally calls `api.anthropic.com` via the Claude Agent SDK. With the Backend picker in ⚙ Settings set to **Local server**, every `/api/agent/edit` request is rerouted to a base URL of your choice. The SDK speaks the Anthropic HTTP wire format, so the local server must too — that's what the translation proxy is for.

## Architecture

```
browser ──HTTP──▶ studio (Node)
                    │
                    ├─ default ──▶ api.anthropic.com
                    │
                    └─ local    ──▶ http://devbox.local:4000  (LiteLLM)
                                      │
                                      └─▶ Ollama / vLLM  (Gemma, Nemotron, …)
```

Routing is per-request: the studio sets `ANTHROPIC_BASE_URL` only on the env it passes to the spawned Claude Code subprocess, so concurrent sessions with different backends don't interfere.

## Dev-machine setup (LiteLLM)

LiteLLM is the recommended proxy because it implements the Anthropic-format `/v1/messages` endpoint, including tool use — which raw Ollama does not. The agent's workflow leans heavily on tool calls (`Read`, `Edit`, `Glob`, `Grep`, `Bash`), so anything less than full tool-use support will fail before the first slide edit lands.

```bash
pip install 'litellm[proxy]'
```

`litellm.config.yaml`:

```yaml
model_list:
  - model_name: gemma3-27b
    litellm_params:
      model: ollama_chat/gemma3:27b
      api_base: http://localhost:11434
  - model_name: nemotron-49b
    litellm_params:
      model: ollama_chat/nemotron:49b
      api_base: http://localhost:11434

general_settings:
  master_key: sk-local-dev
```

Run it bound to all interfaces so the studio (on another machine) can reach it:

```bash
litellm --config litellm.config.yaml --host 0.0.0.0 --port 4000
```

The Anthropic-compatible endpoint is then `http://<devbox-ip>:4000`.

## Studio-side setup

1. Click ⚙ in the toolbar.
2. Pick **Local server**.
3. Fill in:
   - **Base URL**: `http://<devbox-ip>:4000`
   - **Model**: `gemma3-27b` (must match a `model_name` from the LiteLLM config)
   - **API key**: `sk-local-dev` if you set `master_key`, otherwise leave blank.
4. Save. The dot on the toolbar button turns green.

The config is stored in `localStorage` under `fgs_backend` and persists across reloads. Switching back to Anthropic Cloud is the same flow — picker, save, done.

## Headless / env-var fallback

For agent calls that bypass the browser (cron jobs, CI), set `ANTHROPIC_BASE_URL` in `.env`. The browser config takes precedence whenever it's present in the request headers, so this env var only kicks in for requests made without a per-request override.

## Caveats

- Model performance for the agentic Claude Code workflow depends heavily on the model's tool-use capability. Smaller / older / quantized models often fail to follow the system prompt's tool-use directives (e.g. they emit a JSON blob as plain text instead of a `tool_use` block, or refuse to call `Edit`). Gemma 3 27B and Nemotron 49B are reasonable starting points; smaller variants are not.
- LiteLLM's Anthropic translation is feature-complete but not always 1:1 — streaming token usage in particular may come through with zero counts. The studio's UI handles missing usage fields gracefully.
- The studio sends `permissionMode: 'bypassPermissions'` and `allowDangerouslySkipPermissions: true` so the agent never blocks on prompts. This is the same posture as the Anthropic Cloud path, but worth flagging since local models often hallucinate tool calls that an Anthropic model wouldn't.
