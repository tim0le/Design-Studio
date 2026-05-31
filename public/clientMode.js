/*
 * clientMode.js — runtime build-target detection for the Furgoson Studio PWA.
 *
 * The same `public/` bundle ships to two targets:
 *   - selfhost  (default): the Express server provides /api/render, /api/edit,
 *     /api/decks, /api/export, etc. Behavior is IDENTICAL to the pre-PWA app.
 *   - serverless: a static host (Vercel/Netlify) serves public/ + only the
 *     /api/ai-edit function. There is NO render/edit/deck/export server route,
 *     so the client modules (MarpRender, DeckStore, ClientExport, FGS_Locator)
 *     take over.
 *
 * The target is read from a <meta name="fgs-target" content="serverless|selfhost">
 * tag in index.html. Anything other than the literal string "serverless" is
 * treated as selfhost, so the default (no meta / typo) is the safe, regression-
 * free path.
 *
 * Exposes the boolean `window.FGS_CLIENT_RENDER`:
 *   true  -> serverless / client-render mode (use the client modules)
 *   false -> selfhost   / server-render mode (use the /api routes as before)
 *
 * This script MUST load before viewer.js / chat.js / agent.js / app.js so they
 * can branch on the flag during their IIFE initialization.
 */
(function () {
  'use strict';
  var meta = document.querySelector('meta[name="fgs-target"]');
  var target = meta && meta.getAttribute('content');
  // Only the exact string "serverless" enables client mode; everything else
  // (including a missing meta tag) is selfhost.
  window.FGS_TARGET = (target === 'serverless') ? 'serverless' : 'selfhost';
  window.FGS_CLIENT_RENDER = window.FGS_TARGET === 'serverless';
})();
