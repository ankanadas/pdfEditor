#!/usr/bin/env node
// Post-build: inject the offline precache manifest into dist/sw.js so the service worker can cache the app
// SHELL on install (index.html + the content-hashed JS bundles + the mupdf .wasm + css). Those assets are
// requested on the very first page load — before the SW is active — so without an install-time precache an
// offline reload can't boot the app or the WASM engine. Edit-fonts are NOT precached (117 files, several
// MB): they cache on use and degrade gracefully offline (mupdfFonts.js built-in fallback).
const fs = require('fs'), path = require('path');
const DIST = path.join(__dirname, '..', 'dist');
const sw = path.join(DIST, 'sw.js');
if (!fs.existsSync(sw)) { console.error('sw-precache: dist/sw.js not found (run copy:static first)'); process.exit(1); }

const files = fs.readdirSync(DIST)
  .filter((f) => f === 'index.html' || /\.(js|wasm|css)$/.test(f))
  .map((f) => '/' + f);
files.push('/');   // the navigation root

const manifest = 'self.__QPE_PRECACHE__=' + JSON.stringify(files) + ';\n';
fs.writeFileSync(sw, manifest + fs.readFileSync(sw, 'utf8'));
console.log('sw-precache: injected', files.length, 'shell entries into dist/sw.js');
