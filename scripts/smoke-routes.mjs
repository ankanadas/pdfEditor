#!/usr/bin/env node
// Live route smoke test for Quick PDF Editor.
//
// Verifies that the new pages resolve AND that existing functionality is intact:
//   - clean URLs  /about /privacy /terms /contact      -> 200 (correct <title>)
//   - static files /about.html /pages.css /favicon.svg
//                  /og-image.png /.well-known/security.txt -> 200
//   - the editor   /  and /bundle.js                    -> 200 (app still loads)
//
// By default it boots `webpack serve` on a free port, runs the checks, and shuts it
// down. To test an already-running server instead (e.g. your `npm run dev` on :9000):
//   SMOKE_BASE_URL=http://localhost:9000 node scripts/smoke-routes.mjs
//
// Exit code 0 = all checks passed, 1 = one or more failed.
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BOOT_TIMEOUT_MS = 90_000;

// path, expected status, and an optional substring the body must contain.
const CHECKS = [
  { path: '/', needs: 'id="stage"', label: 'editor home loads (existing functionality)' },
  { path: '/about', needs: '<title>About Quick PDF Editor | Free Online PDF Editor' },
  { path: '/privacy', needs: '<title>Privacy Policy | Quick PDF Editor' },
  { path: '/terms', needs: '<title>Terms of Service | Quick PDF Editor' },
  { path: '/contact', needs: 'mailto:support@quickpdfeditor.com' },
  { path: '/about.html', needs: '<title>About Quick PDF Editor | Free Online PDF Editor' },
  { path: '/pages.css', needs: '.site-footer' },
  { path: '/favicon.svg', needs: '<svg' },
  { path: '/og-image.png' },
  { path: '/.well-known/security.txt', needs: 'Contact: mailto:support@quickpdfeditor.com' },
  { path: '/security.txt', needs: 'Contact: mailto:support@quickpdfeditor.com', label: 'root copy (upload-proof safety net)' },
];

function get(base, path) {
  // Send a browser-style navigation Accept header. The dev server's clean-URL
  // rewrite (and any real navigation) only applies to HTML requests, so this mirrors
  // what a browser actually sends when a user clicks a footer link.
  const headers = { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' };
  return new Promise((res) => {
    const req = http.get(base + path, { headers }, (r) => {
      let body = '';
      r.on('data', (c) => (body += c));
      r.on('end', () => res({ status: r.statusCode, body }));
    });
    req.on('error', (err) => res({ status: 0, body: String(err) }));
    req.setTimeout(10_000, () => { req.destroy(); res({ status: 0, body: 'timeout' }); });
  });
}

function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.on('error', rej);
    s.listen(0, () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });
}

async function waitForReady(base) {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const { status } = await get(base, '/');
    if (status === 200) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function runChecks(base) {
  let failures = 0;
  console.log(`\nSmoke-testing routes against ${base}\n`);
  for (const { path, needs, label } of CHECKS) {
    const { status, body } = await get(base, path);
    const okStatus = status === 200;
    const okBody = !needs || (typeof body === 'string' && body.includes(needs));
    const ok = okStatus && okBody;
    if (!ok) failures++;
    const note = label ? `  (${label})` : '';
    let why = '';
    if (!okStatus) why = ` [HTTP ${status}]`;
    else if (!okBody) why = ` [missing "${needs}"]`;
    console.log(`  ${ok ? '✅' : '❌'}  ${path}${note}${why}`);
  }
  // The app bundle is content-hashed, so resolve its name from the served index.html and verify it
  // loads (mirrors the old static /bundle.js check, but hash-proof).
  const home = await get(base, '/');
  const m = /src="(\/?[^"]*bundle\.[^"]+\.js)"/.exec(home.body || '');
  if (m) {
    const bundlePath = m[1].startsWith('/') ? m[1] : `/${m[1]}`;
    const { status } = await get(base, bundlePath);
    const ok = status === 200;
    if (!ok) failures++;
    console.log(`  ${ok ? '✅' : '❌'}  ${bundlePath}  (app bundle is served)${ok ? '' : ` [HTTP ${status}]`}`);
  } else {
    failures++;
    console.log('  ❌  (no hashed bundle script found in index.html)');
  }
  console.log(`\n${failures === 0 ? '✅ all' : `❌ ${failures}`} route checks ${failures === 0 ? 'passed' : 'FAILED'}.\n`);
  return failures;
}

async function main() {
  const external = process.env.SMOKE_BASE_URL;
  if (external) {
    const failures = await runChecks(external.replace(/\/$/, ''));
    process.exit(failures === 0 ? 0 : 1);
  }

  const port = await freePort();
  const base = `http://localhost:${port}`;
  console.log(`Booting webpack dev server on :${port} …`);
  const server = spawn(
    'npx',
    ['webpack', 'serve', '--mode', 'development', '--no-open', '--port', String(port)],
    { cwd: ROOT, stdio: 'ignore', detached: true },
  );

  const shutdown = () => { try { process.kill(-server.pid); } catch { /* already gone */ } };
  process.on('exit', shutdown);
  process.on('SIGINT', () => { shutdown(); process.exit(130); });

  let code = 1;
  try {
    const ready = await waitForReady(base);
    if (!ready) {
      console.error('❌ dev server did not become ready in time.');
    } else {
      const failures = await runChecks(base);
      code = failures === 0 ? 0 : 1;
    }
  } finally {
    shutdown();
  }
  process.exit(code);
}

main();
