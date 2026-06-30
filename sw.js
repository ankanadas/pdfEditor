// sw.js — offline support for Quick PDF Editor.
// The in-browser editing tier (mupdf-wasm) needs its WASM binary + bundled edit-fonts; without caching, an
// offline reload can't load the app OR the engine, and an offline edit collapses to the degraded pdf-lib
// path (lost colour / partial styling). This caches the app shell, the content-hashed bundles + .wasm, and
// /assets/edit-fonts/* on first use, so after one online visit editing works fully offline.
//   • content-hashed assets (bundle.<hash>.js, the .wasm) + the stable edit-fonts → cache-first (safe: a new
//     build changes the hashed URL, so it can't serve a stale bundle);
//   • the HTML shell → network-first, so a new deploy is picked up, with the cache as the offline fallback.
// Same-origin only — the PyMuPDF backend stays network-only (it's the online fallback in the save chain).
const CACHE = 'qpe-cache-v2';
// Shell to pre-cache on install (index.html + content-hashed bundles + .wasm + css). Injected at build
// time by scripts/sw-precache.cjs — the FIRST page load happens before this SW is active, so those assets
// would otherwise never get cached and an offline reload couldn't boot the app. Best-effort per file.
const PRECACHE = self.__QPE_PRECACHE__ || [];

self.addEventListener('install', (e) => e.waitUntil((async () => {
  try { const c = await caches.open(CACHE); await Promise.allSettled(PRECACHE.map((u) => c.add(u))); } catch (_) {}
  await self.skipWaiting();
})()));

self.addEventListener('activate', (e) => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
  await self.clients.claim();
})()));

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  let url;
  try { url = new URL(req.url); } catch (_) { return; }
  if (url.origin !== self.location.origin) return;   // our own assets only

  // HTML shell / navigations → network-first (fresh deploy), cache fallback when offline.
  if (req.mode === 'navigate' || url.pathname === '/' || url.pathname.endsWith('/index.html')) {
    e.respondWith((async () => {
      try {
        const r = await fetch(req);
        (await caches.open(CACHE)).put('/index.html', r.clone());
        return r;
      } catch (_) {
        return (await caches.match('/index.html')) || (await caches.match(req)) || Response.error();
      }
    })());
    return;
  }

  // Everything else (hashed bundles, .wasm, edit-fonts, static assets) → cache-first, fetch + cache on miss.
  e.respondWith((async () => {
    const cached = await caches.match(req);
    if (cached) return cached;
    try {
      const r = await fetch(req);
      if (r && r.ok && (r.type === 'basic' || r.type === 'cors' || r.type === 'default')) {
        (await caches.open(CACHE)).put(req, r.clone());
      }
      return r;
    } catch (_) { return cached || Response.error(); }
  })());
});
