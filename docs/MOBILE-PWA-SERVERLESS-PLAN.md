# Furgoson Studio → Mobile PWA on Serverless — Implementation Plan

**Goal:** Turn the Express/localhost studio into a deployable, installable **mobile-first PWA**
reachable from an iPhone at a permanent URL (no tunnel, no PC, no Cloudflare), with AI editing
**compute outsourced through an API key**. The cloud sandbox is only the dev box; the deliverable
is a real hosted app.

**User decisions (locked):**
- **Hosting:** Serverless + static (Vercel / Netlify).
- **Compute:** Both, user-switchable — direct Anthropic API is the default everywhere; the full
  Claude Code agent is enabled only on a persistent self-hosted build.

> Everything below is grounded in: the official Claude-Code-on-the-web docs, current Vercel/Netlify/
> Marp/Anthropic docs, and direct reading of this repo's source. No general-knowledge assumptions.

---

## 1. What the research established (decisive facts)

- **No inbound ports on Claude Code web.** The platform documents only *outbound* network levels; there
  is no preview-URL/port-forward. Tunnels work but are ephemeral with rotating URLs → wrong for a daily
  driver. ⇒ Deploy as an app. (Confirmed end-to-end.)
- **Marp can render with NO CLI and NO Chromium** via `@marp-team/marp-core` in the **browser**:
  `const {html, css} = new Marp().render(md)`; themes via `marp.themeSet.add(css)` (CSS needs a
  `/* @theme name */` header matched by frontmatter `theme:`). ⇒ Rendering moves client-side; the
  `marp` CLI, temp files, and the render server all disappear. (The CLI is also *absent* in this env.)
- **The `SELECTION_SCRIPT`** (hover/select/drag/inline-edit/delete → `postMessage`) in `lib/marp.js`
  is already pure browser JS ⇒ ports to the client verbatim.
- **Quick-edit locator logic** (`replaceByOuterHtml` / exact / `fuzzyFind` in `routes/edit.js`) is pure
  JS ⇒ moves client-side.
- **Serverless filesystem is read-only** (writable `/tmp` only, ephemeral) ⇒ deck storage must leave the
  server FS.
- **Serverless functions stream SSE** on Vercel Node runtime (≤300s on Hobby w/ fluid compute) and the
  `@anthropic-ai/sdk` runs there with a server-side key ⇒ the AI proxy works.
- **Claude Agent SDK cannot run on plain serverless** (spawns the `claude` subprocess, needs a
  long-lived writable workspace) ⇒ agent path is gated to the self-hosted Express build.
- **PPTX / PPTX-editable** need the CLI browser pipeline + LibreOffice ⇒ dropped on serverless, gated to
  self-host. **PNG/JPG/PDF** are doable client-side (html2canvas / `window.print()` / jsPDF).

## 2. Target architecture (serverless build)

```
iPhone Safari ──HTTPS──> Vercel
  ├── Static PWA (public/)         installable, offline shell (manifest + service worker)
  │     ├── marp-core render        slide HTML in-browser (no server)
  │     ├── SELECTION behaviors     ported from SELECTION_SCRIPT
  │     ├── deck store              IndexedDB working copy (+ seed decks, import/export)
  │     ├── locator + apply edit    ported from routes/edit.js
  │     └── client export           PNG/JPG (html2canvas), PDF (print/jsPDF)
  └── /api/ai-edit  (Node fn)       holds ANTHROPIC_API_KEY, streams SSE edit  ← "compute via API key"
```
The **existing Express server stays** as the *self-host build* (full agent, watch/live-reload, PPTX,
Marp-CLI export). A single feature-flag (`STUDIO_TARGET=serverless|selfhost`) gates agent + pptx + watch.

## 3. Work units

Legend: **[I]** parallel-independent (mostly new/additive files) · **[S]** sequential/shared-file.
Dependencies noted. Files are under `/home/user/Design-Studio`.

### Track A — Mobile PWA shell (UI)
- **A1 [I] PWA install assets.** `public/manifest.webmanifest`, icons (192/512/maskable),
  `apple-touch-icon.png`, `public/sw.js` (offline shell), `<head>` tags in `index.html`
  (manifest link, apple-touch, `theme-color`, `apple-mobile-web-app-*`). _Add-to-home-screen._
- **A2 [S] Viewport + safe-area + typography + tap targets.** `index.html:5` viewport
  `viewport-fit=cover`; `style.css` media queries: `100dvh/svh` shell (replace `100vh`),
  `env(safe-area-inset-*)`, inputs ≥16px (kills iOS focus-zoom), interactive targets ≥44×44,
  scope hover via `@media (hover:hover)`, `:active`/`:focus-visible`, toast wrap+safe-area. (touches
  `style.css`, tiny `index.html`)
- **A3 [S] Responsive shell + bottom tab bar.** Below 900px, collapse the 3-col grid
  (`style.css:109`) to single column with a Decks/Slide/Edit bottom tab bar + panel switching.
  (`index.html` markup, `style.css`, small `public/app.js`). _Depends on A2 tokens._
- **A4 [S] Chat panel mobile.** `visualViewport` keyboard-aware composer + scroll-anchoring
  (only stick-to-bottom when already at bottom). (`public/agent.js`, `public/chat.js`)
- **A5 [S] Slide viewer mobile.** Swipe prev/next + `touch-action:pan-y`, fit-to-width stage,
  collapse the overflowing `.slide-nav` into prev/page/next + a "•••" bottom-sheet. (`public/viewer.js`,
  `style.css`, `index.html`)

### Track B — Serverless core (the re-architecture)
- **B1 [I] Client Marp renderer.** New `public/render/marp-render.js` bundling `@marp-team/marp-core`
  (+ register Furgoson theme CSS as a static asset). Exposes `renderSlide(frontmatter, slideMd) → {html,css}`.
- **B2 [I] Client selection layer.** New `public/render/selection.js` = the ported `SELECTION_SCRIPT`,
  injected into the iframe after B1 render. _No dep (pure port)._
- **B3 [I] Client deck store.** New `public/store/deckStore.js`: IndexedDB CRUD mirroring `lib/deck.js`
  (parse/assemble/add/delete/duplicate/move are pure JS — port them) + seed from committed example decks
  + import/export `.md`.
- **B4 [I] AI proxy function.** New `api/ai-edit.js` (Vercel Node): server-side key, `@anthropic-ai/sdk`
  streaming SSE; reuses the `claude.js` prompts. Returns replacement text only.
- **B5 [S] Client edit apply.** New `public/edit/locator.js` (ported `replaceByOuterHtml`/`fuzzyFind`) +
  wire the Edit panel to call `/api/ai-edit`, apply locally, re-render via B1. _Depends B1,B3,B4._
- **B6 [S] Wire viewer to client render + store.** Replace iframe `src=/api/render/...` with B1 srcdoc;
  route deck list/CRUD through B3 instead of `/api/decks`. _Depends B1,B2,B3._
- **B7 [I] Client export.** New `public/export/clientExport.js`: PNG/JPG (html2canvas), PDF
  (`window.print()` stylesheet + jsPDF option). Wire export menu. (PPTX buttons hidden on serverless.)
- **B8 [I] Deploy config + feature gating.** `vercel.json` (static `public/` + `/api`, `maxDuration`,
  fluid compute), `STUDIO_TARGET` flag gating agent/pptx/watch in `server.js`, `.env` docs,
  `README` deploy steps (Vercel import + `ANTHROPIC_API_KEY` env), keep Express as self-host build.

### Track C — Optional (gated, self-host only)
- **C1 [I] Remotion deck→video scaffold.** `lib/remotion/` (composition + PNG-reuse via Marp) +
  `POST /api/video` async/SSE job — **self-host build only** (needs Chromium). Ship behind the flag.
  *(Recommend deferring until A+B land; included for completeness from the feasibility research.)*

**Dependency graph:** A1, B1, B2, B3, B4, B7, B8 are independent. A2→A3→A4/A5. B5 needs B1/B3/B4.
B6 needs B1/B2/B3. C1 standalone (self-host).

## 4. E2E test recipe (per unit)

There is **no browser-automation skill** in this environment and the Marp CLI is absent, so e2e is:

1. **Static/PWA + client JS (A*, B1/B2/B3/B5/B6/B7):** `node --check` every changed JS; then start a
   static server (`npx serve public` or `node server.js` for self-host) and load with **headless
   Chromium via puppeteer** (Chromium libs are present in this env) at **390×844 (iPhone)**:
   assert (a) no horizontal scroll (`document.scrollWidth <= innerWidth`), (b) the affected control
   exists/clicks, (c) a slide iframe renders non-empty, and **save a screenshot** as the artifact. If
   puppeteer can't install, fall back to a **jsdom** DOM smoke test + manual screenshot note.
2. **AI proxy (B4):** start a local Node handler, `curl` `/api/ai-edit` with a fake key and assert the
   SSE framing/validation path (401 without key, 400 on missing fields); with a real key (if
   `ANTHROPIC_API_KEY` present) assert a streamed replacement.
3. **Deploy config (B8):** `vercel build`/schema-validate `vercel.json`; confirm self-host `node
   server.js` still boots with the flag.
4. **All units:** run `/code-review`, fix findings, then any unit tests (`npm test` — none today, so
   add a minimal smoke test where practical).

## 5. Out of scope / dropped on serverless
Live-reload watch SSE (no FS to watch), PPTX + PPTX-editable (CLI/LibreOffice), Marp-CLI server render.
All remain available on the **self-host** build behind `STUDIO_TARGET=selfhost`.
