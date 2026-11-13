import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The runner (scripts/test.mjs) starts the bundled test in the package folder.
const src = (f: string) => readFileSync(join(process.cwd(), 'src', f), 'utf8');
import { renderToStaticMarkup } from 'react-dom/server';
import { cleanShowcase, type Showcase } from '@tm-hub/shared/showcase';
import { ShowcaseView, type ShowcaseCtx } from '../src/index.ts';

const IMG = 'https://raw.githubusercontent.com/o/r/main/docs/images/a.png';
const sc = (blocks: unknown[], accent = 'orange'): Showcase => cleanShowcase({ version: 1, theme: { accent }, blocks })!;
const html = (s: Showcase, ctx: ShowcaseCtx = {}) => renderToStaticMarkup(<ShowcaseView showcase={s} ctx={ctx} />);

test('every block type renders its content', () => {
  const s = sc([
    { type: 'hero', title: 'Mod name', tagline: 'Tagline', image: IMG, badges: ['One', 'Two'] },
    { type: 'features', title: 'Why', items: [{ icon: 'sun', title: 'Light', text: 'Sun and shadows' }] },
    { type: 'gallery', images: [{ url: IMG, caption: 'Shot one' }] },
    { type: 'compare', before: { url: IMG, label: 'Off' }, after: { url: IMG, label: 'On' }, caption: 'Slide it' },
    { type: 'video', url: 'https://youtu.be/dQw4w9WgXcQ', caption: 'Trailer' },
    { type: 'text', markdown: '## Heading\n\n- one\n- **two**\n\n```\ncode\n```' },
    { type: 'compat', rows: [{ game: 'tmnf', status: 'works' }, { game: 'eswc', status: 'partial', note: 'patch only' }] },
    { type: 'hotkeys', rows: [{ keys: 'Ctrl+F5', action: 'Toggle' }] },
    { type: 'changelog', count: 1 },
    { type: 'faq', items: [{ q: 'Why?', a: 'Because **so**.' }] },
    { type: 'cta', buttons: [{ kind: 'install', label: 'Install now' }, { kind: 'companion', label: 'Board' }, { kind: 'link', label: 'Docs', url: 'https://example.com/d' }] },
  ]);
  const h = html(s, {
    gameName: (id) => (id === 'tmnf' ? 'TrackMania Nations Forever' : id),
    releases: [{ version: '1.2.0', date: '2026-11-01T10:00:00Z', notes: '- fixed a thing\n- added **stuff**' }, { version: '1.1', notes: 'older' }],
    onInstall: () => {},
    companion: { label: 'Board', url: 'https://100tmx.com/events/bingo' },
  });
  for (const want of [
    'data-accent="orange"', '<h1>Mod name</h1>', 'Tagline', '>One<', 'class="sc-hero-img"', '<h2 class="sc-title">Why</h2>', 'Sun and shadows', 'Shot one',
    'class="sc-compare"', 'type="range"', '>Off<', '>On<', 'Slide it', 'Trailer', '<h3>Heading</h3>', '<li><strong>two</strong></li>', '<pre><code>code</code></pre>',
    'TrackMania Nations Forever', 'sc-status partial', 'patch only', '<kbd>Ctrl</kbd>', '<kbd>F5</kbd>', 'Latest changes', '1.2.0', '2026-11-01', 'fixed a thing',
    '<summary>Why?</summary>', '<strong>so</strong>', 'Install now', 'href="https://100tmx.com/events/bingo"', 'href="https://example.com/d"',
  ]) assert.ok(h.includes(want), `missing: ${want}`);
  assert.ok(!h.includes('older'), 'changelog count 1 shows one release');
});

test('video is click-to-load: no iframe and no request to the video site before the click', () => {
  const h = html(sc([{ type: 'video', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }]));
  assert.ok(!/<iframe/i.test(h));
  assert.ok(!/ytimg|i\.ytimg|youtube-nocookie\.com\/embed[^"]*"[^>]*src/i.test(h.replace(/data-sc-video="[^"]*"/, '')), 'no thumbnail request');
  assert.ok(h.includes('data-sc-video="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1"'));
  assert.ok(h.includes('Loads from YouTube when you click.'));
  assert.ok(h.includes('href="https://www.youtube.com/watch?v=dQw4w9WgXcQ"'));
});

test('no HTML injection: author text is escaped, bad links and pictures never reach the markup', () => {
  const evil = '<script>alert(1)</script><img src=x onerror=alert(2)>';
  const s = sc([
    { type: 'hero', title: evil, tagline: evil },
    { type: 'text', markdown: `${evil}\n\n[bad](javascript:alert(3)) [ok](https://example.com/ok) ![x](https://evil.example/x.png)\n\n\`\`\`\n${evil}\n\`\`\`` },
    { type: 'faq', items: [{ q: evil, a: `${evil} [j](javascript:alert(4))` }] },
    { type: 'hotkeys', rows: [{ keys: evil, action: evil }] },
    { type: 'cta', buttons: [{ kind: 'link', label: evil, url: 'https://example.com/x' }] },
  ]);
  const h = html(s);
  assert.ok(!/<script/i.test(h));
  assert.ok(!/<img[^>]*onerror/i.test(h));
  assert.ok(!/javascript:/i.test(h));
  assert.ok(!h.includes('evil.example'));
  assert.ok(h.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(h.includes('href="https://example.com/ok"'));
  // no element carries an event handler attribute (the escaped text above contains "onerror=" only as text)
  assert.ok(!/<[^>]*\son\w+\s*=/i.test(h));
});

test('links open safely: rel noopener, target blank; pictures carry no referrer', () => {
  const h = html(sc([{ type: 'text', markdown: '[a](https://example.com/a)' }, { type: 'gallery', images: [{ url: IMG }] }]));
  assert.ok(/<a [^>]*href="https:\/\/example\.com\/a"[^>]*rel="noopener noreferrer nofollow"/.test(h) || /<a [^>]*rel="noopener noreferrer nofollow"[^>]*href="https:\/\/example\.com\/a"/.test(h));
  assert.ok(h.includes('referrerPolicy') || h.includes('referrerpolicy="no-referrer"'));
});

test('buttons and blocks that cannot work here are left out', () => {
  const s = sc([{ type: 'changelog' }, { type: 'cta', buttons: [{ kind: 'install', label: 'Install' }, { kind: 'companion', label: 'Board' }] }]);
  const h = html(s);
  assert.ok(!h.includes('Latest changes'));
  assert.ok(!h.includes('Install'));
  assert.ok(!h.includes('sc-cta'));
  assert.ok(html(s, { installHref: 'tmhub://install/x' }).includes('href="tmhub://install/x"'));
});

test('host hooks: Img component and onLink are used', () => {
  const s = sc([{ type: 'gallery', images: [{ url: IMG, caption: 'c' }] }, { type: 'text', markdown: '[a](https://example.com/a)' }]);
  const h = html(s, { Img: ({ url, alt }) => <i data-cached={url} data-alt={alt} />, onLink: () => {} });
  assert.ok(h.includes(`data-cached="${IMG}"`));
});

test('light and dark: accent variants exist for every palette colour and the theme switch', () => {
  const css = src('showcase.css');
  for (const a of ['blue', 'cyan', 'green', 'lime', 'amber', 'orange', 'red', 'pink', 'violet', 'slate']) {
    assert.ok(css.includes(`.sc[data-accent="${a}"]`), `dark ${a}`);
    assert.ok(css.includes(`.sc[data-scheme="light"][data-accent="${a}"]`) && css.includes(`:root[data-theme="light"] .sc:not([data-scheme])[data-accent="${a}"]`) && css.includes(`:root:not([data-theme]) .sc:not([data-scheme])[data-accent="${a}"]`), `light ${a}`);
  }
});

test('the renderer never uses dangerouslySetInnerHTML or innerHTML', () => {
  for (const f of ['Showcase.tsx', 'enhance.ts']) {
    assert.ok(!/dangerouslySetInnerHTML|innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/.test(src(f)), f);
  }
});
