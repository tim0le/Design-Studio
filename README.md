# Design Studio

A code-driven slide editor built on Marp, with a Claude Code agent baked into the right panel for natural-language editing.

> Originally built for Furgoson's internal deck production; the app code is generic — bring your own decks + theme.

## What it does

- **Live deck editor in the browser** — three-panel layout: deck list, slide viewer, edit panel
- **Direct manipulation** — click to select, drag to reposition (via CSS transform, no layout reflow), double-click to edit text inline, Delete to remove an element; every element gets a stable UUID in source so operations are idempotent
- **Two Claude paths** — a quick single-shot edit mode and a full Claude Code agent session with `Read / Edit / Glob / Grep / Bash` tools that streams its reasoning to the panel as a transcript
- **Local LLM routing** — point the agent at any Anthropic-compatible endpoint (e.g. a LiteLLM proxy on a dev box exposing Gemma / Nemotron) via the settings dialog
- **Exports** — full deck or single slide to PDF, PPTX (exact rasterized, recommended), PPTX (editable via LibreOffice, beta), PNG, JPG, HTML
- **Multi-format import** — drop `.md`, `.html`, `.txt`, or an image (PNG/JPG/WebP/GIF) and the studio wraps it as a Marp slide / one-pager
- **Slide CRUD** — add / duplicate / reorder / delete slides
- **Raw source drawer** — see and edit the underlying Markdown for any slide
- **Live reload** — `chokidar` watches the decks dir; external edits refresh the iframe automatically

## Quick start

```bash
git clone git@github.com:tim0le/Design-Studio.git
cd Design-Studio
npm install
node server.js
```

Open http://localhost:3000. On first launch with no decks dir configured, the studio falls back to the **starter studio** bundled in `examples/starter-studio/` — three slides showing what the studio can do.

To point the studio at your own deck content, you have two options (see [Studio layout](#studio-layout) below).

## Two build targets

The studio ships in one codebase with two deploy modes, selected by the
`STUDIO_TARGET` environment variable (default `selfhost`):

| Target | Where | AI editing | Agent | Live reload | PPTX export |
|--------|-------|-----------|-------|-------------|-------------|
| `selfhost` (default) | your PC / a box you control (`npm start`) | quick-edit + agent | ✅ | ✅ | ✅ |
| `serverless` | Vercel (static `public/` + `/api` functions) | direct-API `/api/ai-edit` only | ❌ | ❌ | ❌ (PNG/JPG/PDF only) |

On the **serverless** build the Claude Code agent path, live-reload watch, and
PPTX / PPTX-editable exports are **unavailable** — they need a subprocess, a
writable workspace, and the Marp CLI / LibreOffice. Use the **self-host** build
when you need any of those.

## Deploying as a mobile PWA (Vercel)

This gets you a permanent `https://<project>.vercel.app` URL you can open on an
iPhone and install to the home screen — no tunnel, no PC kept running.

1. **Push the repo to GitHub** (any account):
   ```bash
   git push origin main
   ```
2. **Import into Vercel** — at https://vercel.com/new, pick the GitHub repo.
   Vercel reads `vercel.json` automatically: static files are served from
   `public/`, any `api/*.js` file becomes a Node serverless function (300s
   `maxDuration` via fluid compute), and all other routes fall back to the
   SPA shell (`public/index.html`).
3. **Set environment variables** (Project → Settings → Environment Variables):
   - `ANTHROPIC_API_KEY` — your `sk-ant-…` key (used server-side by `/api/ai-edit`).
   - `STUDIO_TARGET` — `serverless`.
4. **Deploy.** Vercel builds and gives you a `*.vercel.app` URL.
5. **Install on iPhone** — open the `*.vercel.app` URL in Safari, tap **Share →
   Add to Home Screen**. It launches full-screen like a native app.

> On the serverless build, AI editing runs through the direct-API `/api/ai-edit`
> function (your key stays on the server). The agent, live-reload, and PPTX
> exports are self-host-only — see below.

## Self-hosting (full build)

For the agent path, live reload, and PPTX export, run the Express app yourself:

```bash
npm install
STUDIO_TARGET=selfhost npm start   # selfhost is also the default
```

Requires the **`marp` CLI** (`npm install -g @marp-team/marp-cli`) and, for
editable-PPTX export, **LibreOffice**. See [Prerequisites](#prerequisites).
This is also the dev environment for working on the serverless build.

See [`docs/MOBILE-PWA-SERVERLESS-PLAN.md`](docs/MOBILE-PWA-SERVERLESS-PLAN.md)
for the full architecture and rationale behind the two targets.

## Prerequisites

| Tool | Why | Install |
|------|-----|---------|
| **Node 22+** | Runs the server and SDKs | https://nodejs.org/ |
| **Marp CLI** | Renders slides to HTML / PDF / PPTX / PNG | `npm install -g @marp-team/marp-cli` |
| **Google Chrome** | Marp uses it headlessly for PDF / PPTX / image renders | https://chrome.google.com/ |
| **LibreOffice** (optional) | Only needed for `PPTX (editable, beta)` mode | https://www.libreoffice.org/ or `winget install TheDocumentFoundation.LibreOffice` |

## Studio layout

The app reads decks, theme files, and assets from a "studio root" directory. Resolved in priority order:

1. **`$FURGOSON_DECK_REPO`** — explicit env override (any absolute path)
2. **`../furgoson-studio/`** — sibling directory next to this repo (production layout)
3. **`examples/starter-studio/`** — bundled fallback so a fresh clone has something to render

The studio root must contain at least:

```
<studio-root>/
├── decks/
│   ├── <lang>/                    # e.g. de/, en/ — language buckets
│   │   ├── my_deck.md             # Marp markdown, one file per deck
│   │   └── one_pager/             # optional sub-bucket for single-slide assets
│   │       └── product_brief.md
│   └── ...
├── theme/
│   └── my_theme.css               # one or more Marp themes (any name)
└── assets/                        # images, fonts, anything referenced from decks
```

Decks declare which theme they use via Marp frontmatter:

```markdown
---
marp: true
theme: my_theme
paginate: false
size: 16:9
html: true
---

# Slide 1
```

The studio registers every `.css` in the theme dir, so multiple themes can coexist; each deck picks one by name in its frontmatter.

## Configuring the agent

The agent chat panel defaults to Anthropic Cloud (Claude Sonnet). Click ⚙ **API Key** in the toolbar and pick:

- **Anthropic Cloud** — paste your `sk-ant-…` key
- **Local server** — set base URL (e.g. `http://devbox.local:4000`) and model name. The studio sends Anthropic-protocol requests to that URL via the Anthropic SDK's `baseURL` option. For Gemma / Nemotron / Llama bridging via Ollama, see `README_LOCAL_LLM.md`.

The key is stored in `localStorage` and never sent to the studio's own backend except as the per-request `X-API-Key` header that gets forwarded to Anthropic (or your local proxy).

## Project-specific conventions for Claude

See `CLAUDE.md` for the agent's editing rules — scope-of-change guards, design tokens, language conventions. When customizing for a different brand, edit `lib/agentSystemPrompt.js` and `CLAUDE.md` together.

## License

Private — internal Furgoson use. Contact tim0le for access.
