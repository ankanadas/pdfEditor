// Static guards for the public-facing pages, footer, SEO assets, redirects and
// security headers. These read files only (no server, no build) so they run fast as
// part of `npm test` and fail loudly if a future change drops a page, a footer link,
// a canonical/OG tag, a redirect rule, or a security header.
import { describe, it, expect } from '@jest/globals';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

const CONTENT_PAGES = [
  { file: 'about.html', slug: 'about', title: 'About' },
  { file: 'privacy.html', slug: 'privacy', title: 'Privacy Policy' },
  { file: 'terms.html', slug: 'terms', title: 'Terms of Service' },
  { file: 'contact.html', slug: 'contact', title: 'Contact' },
];

const FOOTER_LINKS = ['/about', '/privacy', '/terms', '/contact'];

describe('public content pages exist and are well-formed', () => {
  it.each(CONTENT_PAGES)('$file is present with one <h1> and the right title', ({ file, title }) => {
    const html = read(file);
    expect(html).toContain('<!DOCTYPE html>');
    expect((html.match(/<h1[ >]/g) || []).length).toBe(1);
    const titleTag = (html.match(/<title>([^<]*)<\/title>/) || [])[1] || '';
    expect(titleTag).toContain(title);            // page name present
    expect(titleTag).toContain('Quick PDF Editor'); // brand present (separator-agnostic)
    // basic tag balance
    expect((html.match(/<body[ >]/g) || []).length).toBe(html.split('</body>').length - 1);
    expect((html.match(/<footer[ >]/g) || []).length).toBe(html.split('</footer>').length - 1);
  });

  it.each(CONTENT_PAGES)('$file has a correct canonical, OG image and skip link', ({ file, slug }) => {
    const html = read(file);
    expect(html).toContain(`<link rel="canonical" href="https://quickpdfeditor.com/${slug}" />`);
    expect(html).toContain('property="og:image" content="https://quickpdfeditor.com/og-image.png"');
    expect(html).toContain('class="skip-link"');
    expect(html).toContain('href="/pages.css"');
  });

  it.each(CONTENT_PAGES)('$file footer links to every other page', ({ file }) => {
    const html = read(file);
    for (const link of FOOTER_LINKS) {
      expect(html).toContain(`href="${link}"`);
    }
    expect(html).toContain('href="/"'); // back to the editor
  });

  it('contact page surfaces the support email and ContactPage schema', () => {
    const html = read('contact.html');
    expect(html).toContain('mailto:support@quickpdfeditor.com');
    const ld = extractJsonLd(html);
    expect(ld.length).toBeGreaterThan(0);
    expect(ld.some((o) => o['@type'] === 'ContactPage')).toBe(true);
  });

  it('contact page has a Netlify-wired contact form (name, email, message + honeypot)', () => {
    const html = read('contact.html');
    expect(html).toMatch(/<form[^>]*\bname="contact"/);
    expect(html).toContain('data-netlify="true"');
    expect(html).toContain('netlify-honeypot="bot-field"');
    expect(html).toContain('name="form-name" value="contact"'); // required for AJAX + matching
    for (const field of ['name="name"', 'name="email"', 'name="message"', 'name="bot-field"']) {
      expect(html).toContain(field);
    }
  });
});

describe('homepage (index.html) trust, footer, a11y and SEO', () => {
  const html = () => read('index.html');

  it('shows the five trust statements on the landing hero', () => {
    const h = html();
    for (const phrase of [
      'No account required',
      'Free to use',
      'No subscriptions',
      'No permanent file storage',
      'Secure HTTPS connection',
    ]) {
      expect(h).toContain(phrase);
    }
    expect(h).toContain('class="trust-badges"');
  });

  it('has a footer linking to every content page', () => {
    const h = html();
    expect(h).toContain('class="appfoot"');
    for (const link of FOOTER_LINKS) {
      expect(h).toContain(`href="${link}"`);
    }
  });

  it('keeps SEO essentials: canonical, OG image, twitter image, valid JSON-LD', () => {
    const h = html();
    expect(h).toContain('<link rel="canonical" href="https://quickpdfeditor.com/" />');
    expect(h).toContain('property="og:image" content="https://quickpdfeditor.com/og-image.png"');
    expect(h).toContain('name="twitter:image"');
    const ld = extractJsonLd(h);
    expect(ld.some((o) => o['@type'] === 'WebApplication')).toBe(true);
  });

  it('has the accessibility fixes (skip link, labelled controls, main landmark)', () => {
    const h = html();
    expect(h).toContain('class="skip-link"');
    expect(h).toContain('id="main-content"');
    expect(h).toContain('aria-label="Font family for added text"');
    expect(h).toContain('aria-label="Font size in points"');
  });
});

describe('SEO + security static files', () => {
  it('sitemap lists the homepage and all four content pages', () => {
    const xml = read('sitemap.xml');
    for (const loc of [
      'https://quickpdfeditor.com/',
      'https://quickpdfeditor.com/about',
      'https://quickpdfeditor.com/privacy',
      'https://quickpdfeditor.com/terms',
      'https://quickpdfeditor.com/contact',
    ]) {
      expect(xml).toContain(`<loc>${loc}</loc>`);
    }
  });

  it('robots.txt points at the sitemap', () => {
    expect(read('robots.txt')).toContain('Sitemap: https://quickpdfeditor.com/sitemap.xml');
  });

  it('_redirects maps every clean URL to its .html file (200 rewrite)', () => {
    const r = read('_redirects');
    for (const slug of ['about', 'privacy', 'terms', 'contact']) {
      expect(r).toMatch(new RegExp(`/${slug}\\s+/${slug}\\.html\\s+200`));
    }
  });

  it('_headers sets the key security headers and allows the backend origin in CSP', () => {
    const h = read('_headers');
    expect(h).toContain('X-Content-Type-Options: nosniff');
    expect(h).toContain('Strict-Transport-Security:');
    expect(h).toContain('Content-Security-Policy:');
    expect(h).toContain('https://pdf-editor-backend-jndx.onrender.com'); // connect-src for the editor
  });

  it('security.txt is RFC 9116-shaped (Contact + Expires)', () => {
    const s = read('.well-known/security.txt');
    expect(s).toContain('Contact: mailto:support@quickpdfeditor.com');
    expect(s).toMatch(/Expires:\s*\d{4}-\d{2}-\d{2}T/);
  });

  it('brand assets exist and are non-empty', () => {
    for (const f of ['pages.css', 'favicon.svg', 'og-image.png']) {
      expect(existsSync(join(ROOT, f))).toBe(true);
      expect(readFileSync(join(ROOT, f)).length).toBeGreaterThan(0);
    }
  });
});

// When a production build is present, confirm copy:static actually placed everything
// (and nested .well-known) into dist/. Skipped automatically if dist/ hasn't been built.
const distBuilt = existsSync(join(ROOT, 'dist', 'index.html'));
(distBuilt ? describe : describe.skip)('build output (dist/) — copy:static result', () => {
  it('dist contains every static page, asset, header and redirect file', () => {
    for (const f of [
      'about.html', 'privacy.html', 'terms.html', 'contact.html',
      'pages.css', 'favicon.svg', 'og-image.png',
      '_headers', '_redirects', 'robots.txt', 'sitemap.xml',
      '.well-known/security.txt',
    ]) {
      expect(existsSync(join(ROOT, 'dist', f))).toBe(true);
    }
  });
});

function extractJsonLd(html) {
  const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  return blocks.map((m) => JSON.parse(m[1]));
}
