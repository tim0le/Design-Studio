// Entry point for the browser-loadable Marp Core bundle.
//
// esbuild bundles this into public/vendor/marp-core.bundle.js as an IIFE that
// exposes a single global, `MarpCore`, with a `Marp` constructor:
//
//   const marp = new MarpCore.Marp();
//   const { html, css } = marp.render('# Hello');
//
// Regenerate with:  npm run build:marp
import { Marp } from '@marp-team/marp-core';

export { Marp };
