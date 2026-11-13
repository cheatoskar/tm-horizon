import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderReadme } from '../src/readme.ts';

test('scripts, handlers, iframes, forms and bad URLs do not get through', () => {
  const h = renderReadme([
    '<script>alert(1)</script>', '<img src="x" onerror="alert(1)">', '<iframe src="https://evil.example"></iframe>',
    '<form action="/x"><input name="a"><button>go</button></form>', '[x](javascript:alert(1))', '[y](data:text/html,hi)',
    '<svg onload="alert(1)"><a xlink:href="javascript:alert(1)">z</a></svg>', '<style>body{display:none}</style>',
    '<a href="https://ok.example" onclick="alert(1)" style="color:red">fine</a>', '<div style="position:fixed" onmouseover="x()">box</div>',
  ].join('\n\n'));
  assert.doesNotMatch(h, /<script|<iframe|<form|<input|<button|<style|<svg|onerror|onclick|onload|onmouseover|javascript:|data:text|style=/i);
  assert.match(h, /<a href="https:\/\/ok\.example"[^>]*>fine<\/a>/);
  assert.match(h, /box/);
});

test('relative links and pictures resolve against the repository', () => {
  const h = renderReadme('<img src="docs/a b.png"> [guide](docs/G.md) [top](#usage) ![abs](http://x.example/p.png)', { repo: 'o/r' });
  assert.match(h, /src="https:\/\/raw\.githubusercontent\.com\/o\/r\/HEAD\/docs\/a%20b\.png"/);
  assert.match(h, /href="https:\/\/github\.com\/o\/r\/blob\/HEAD\/docs\/G\.md"/);
  assert.match(h, /href="#usage"/);
  assert.match(h, /src="https:\/\/x\.example\/p\.png"/);
  const none = renderReadme('![shot](docs/a.png) [guide](docs/G.md)');
  assert.doesNotMatch(none, /<img|href=/);
});

test('first H1 that repeats the title goes, others move down one level, headings get ids', () => {
  const h = renderReadme('# TM Vibrant Shaders\n\nintro\n\n# Install\n\n## Usage\n\n## Usage', { title: 'TM Vibrant Shaders' });
  assert.doesNotMatch(h, /Vibrant/);
  assert.match(h, /<h2 id="install">Install<\/h2>/);
  assert.match(h, /<h3 id="usage">Usage<\/h3>/);
  assert.match(h, /<h3 id="usage-1">Usage<\/h3>/);
  const kept = renderReadme('# Something else\n\ntext', { title: 'Mod' });
  assert.match(kept, /<h2 id="something-else">/);
});

test('badges: kept and marked, or dropped with their link and paragraph', () => {
  const md = '[![build](https://img.shields.io/badge/a-b-green.svg)](https://ci.example)\n\ntext';
  assert.match(renderReadme(md), /class="rd-badge"/);
  const d = renderReadme(md, { dropBadges: true });
  assert.doesNotMatch(d, /img|<a|shields/);
  assert.match(d, /<p>text<\/p>/);
});

test('tables get a scroll wrapper, task lists get boxes, picture hooks apply', () => {
  const h = renderReadme('| a | b |\n|---|---|\n| 1 | 2 |\n\n- [x] done\n- [ ] open', { repo: 'o/r' });
  assert.match(h, /<div class="rd-table"><table>/);
  assert.match(h, /☑ done/);
  assert.match(h, /☐ open/);
  const lazy = renderReadme('![a](https://x.example/a.png)', { lazySrc: true });
  assert.match(lazy, /data-src="https:\/\/x\.example\/a\.png"/);
  assert.doesNotMatch(lazy, / src=/);
  const proxied = renderReadme('![a](https://x.example/a.png) ![b](https://y.example/b.png)', { imageUrl: (u) => (u.includes('x.example') ? '/p/a.png' : null) });
  assert.match(proxied, /src="\/p\/a\.png"/);
  assert.doesNotMatch(proxied, /y\.example/);
});

test('an empty table head is left out', () => {
  assert.doesNotMatch(renderReadme('| | |\n|-|-|\n| a | b |'), /<thead/);
});
