// One-pager importers — turn various source formats into a single-slide Marp .md
// suitable for the Furgoson deck pipeline.
//
// Each importer returns a string of complete Marp markdown including frontmatter.
// Image and binary assets are written into furgoson-studio/assets/uploads/ and
// referenced by relative path so Marp can resolve them at render time.

const fs = require('fs');
const path = require('path');

const STUDIO_DIR = path.resolve(__dirname, '../../furgoson-studio');
const ASSET_UPLOAD_DIR = path.join(STUDIO_DIR, 'assets', 'uploads');

function ensureAssetDir() {
  if (!fs.existsSync(ASSET_UPLOAD_DIR)) {
    fs.mkdirSync(ASSET_UPLOAD_DIR, { recursive: true });
  }
}

// Sanitize a filename to ASCII-safe characters for paths and ids.
function safeName(name) {
  return String(name)
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .toLowerCase()
    .substring(0, 60) || 'one_pager';
}

// Strip BOM and normalize line endings.
function cleanText(s) {
  return String(s).replace(/^﻿/, '').replace(/\r\n/g, '\n');
}

const FRONTMATTER = (title) => `---
marp: true
theme: furgoson
paginate: false
size: 16:9
title: ${title}
---
`;

// .md — accept as-is if it already has Marp frontmatter; otherwise wrap.
function importMarkdown({ name, content }) {
  const text = cleanText(content);
  if (/^---\s*\n[\s\S]*?\bmarp:\s*true\b[\s\S]*?\n---/m.test(text)) {
    return text;
  }
  const title = safeName(name).replace(/_/g, ' ');
  return `${FRONTMATTER(title)}
<!-- _class: top -->

${text.trim()}
`;
}

// .html — embed the body content inside a Marp slide. We don't try to preserve
// <head>/<script>/<style> — Marp slides have their own theme and security model.
function importHtml({ name, content }) {
  const text = cleanText(content);
  // Extract just the <body>…</body> if present; otherwise use as-is.
  const bodyMatch = text.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const body = bodyMatch ? bodyMatch[1].trim() : text.trim();
  const title = safeName(name).replace(/_/g, ' ');
  return `${FRONTMATTER(title)}
<!-- _class: top -->

<div>
${body}
</div>
`;
}

// .txt — first non-empty line becomes the slide title (h2), rest becomes the body.
function importText({ name, content }) {
  const text = cleanText(content).trim();
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const title = (lines.shift() || safeName(name).replace(/_/g, ' ')).replace(/[#>*_`~]+/g, '').trim();
  const body = lines.join('\n\n');
  return `${FRONTMATTER(title)}
<!-- _class: top -->

## ${title}

${body}
`;
}

// Image — save to assets/uploads/ and reference as a Marp background image so
// the one-pager renders as the image itself with optional caption text.
function importImage({ name, contentBase64, mime }) {
  ensureAssetDir();
  const base = safeName(name);
  const ext = (mime && mime.split('/')[1]) || (name.match(/\.([a-z0-9]+)$/i) || [, 'png'])[1];
  const cleanExt = ext.toLowerCase().replace(/[^a-z0-9]/g, '');
  const filename = `${base}_${Date.now()}.${cleanExt}`;
  const targetPath = path.join(ASSET_UPLOAD_DIR, filename);

  // Strip data URL prefix if present.
  const b64 = String(contentBase64).replace(/^data:[^,]+,/, '');
  fs.writeFileSync(targetPath, Buffer.from(b64, 'base64'));

  const title = base.replace(/_/g, ' ');
  const relPath = `assets/uploads/${filename}`;
  return `${FRONTMATTER(title)}
<!-- _class: top -->

![bg](${relPath})

`;
}

function detectFormat(filename) {
  const ext = (filename.match(/\.([a-z0-9]+)$/i) || [, ''])[1].toLowerCase();
  if (ext === 'md' || ext === 'markdown') return 'md';
  if (ext === 'html' || ext === 'htm') return 'html';
  if (ext === 'txt') return 'txt';
  if (['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(ext)) return 'image';
  if (ext === 'pdf') return 'pdf';
  if (ext === 'pptx' || ext === 'ppt') return 'pptx';
  return 'unknown';
}

// Main dispatch: returns { deckId, markdown } given the upload payload.
// `lang` is 'en' or 'de'; `kind` is 'deck' or 'one_pager'.
function convertToDeckSource({ name, content, contentBase64, mime, lang, kind }) {
  const validLang = ['de', 'en'].includes(lang) ? lang : 'en';
  const folder = kind === 'one_pager' ? `${validLang}/one_pager` : validLang;
  const slug = safeName(name);
  const deckId = `${folder}/${slug}`;
  const format = detectFormat(name);

  let markdown;
  switch (format) {
    case 'md':    markdown = importMarkdown({ name, content }); break;
    case 'html':  markdown = importHtml({ name, content });     break;
    case 'txt':   markdown = importText({ name, content });     break;
    case 'image': markdown = importImage({ name, contentBase64, mime }); break;
    case 'pdf':
      throw new Error('PDF import is not yet supported. Export the PDF pages as PNG and import those, or paste the text as a .txt file.');
    case 'pptx':
      throw new Error('PPTX import is not yet supported. Export the slides as PNG/PDF or save the source as .md and re-upload.');
    default:
      throw new Error(`Unsupported file type: .${name.split('.').pop()}. Supported: md, html, txt, png, jpg, jpeg, webp, gif.`);
  }

  return { deckId, markdown, format };
}

module.exports = { convertToDeckSource, detectFormat, safeName };
