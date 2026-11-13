import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ACCENTS, BLOCK_TYPES, SHOWCASE_ICONS, SHOWCASE_LIMITS, cleanImageUrl, cleanShowcase, parseInline, parseMarkdown, parseVideoUrl, showcaseOf, validateShowcase,
} from '../src/showcase.ts';

const IMG = 'https://raw.githubusercontent.com/o/r/main/docs/images/a.png';
const good = () => ({
  version: 1,
  theme: { accent: 'orange' },
  blocks: [
    { type: 'hero', title: 'Mod', tagline: 'Does things', image: IMG, video: 'https://youtu.be/dQw4w9WgXcQ', badges: ['TMNF', 'Open source'] },
    { type: 'features', items: [{ icon: 'sun', title: 'Light', text: 'Sun and shadows' }] },
    { type: 'gallery', images: [{ url: IMG, caption: 'One' }] },
    { type: 'compare', before: { url: IMG, label: 'Off' }, after: { url: IMG } },
    { type: 'video', url: 'https://vimeo.com/123456789' },
    { type: 'text', markdown: '## Hi\n\n- a\n- **b**\n\n[x](https://example.com)' },
    { type: 'compat', rows: [{ game: 'tmnf', status: 'works' }, { game: 'eswc', status: 'partial', note: 'patch only' }] },
    { type: 'hotkeys', rows: [{ keys: 'Ctrl+F5', action: 'Toggle' }] },
    { type: 'changelog', count: 2 },
    { type: 'faq', items: [{ q: 'Why?', a: 'Because.' }] },
    { type: 'cta', buttons: [{ kind: 'install', label: 'Install' }, { kind: 'link', label: 'Docs', url: 'https://example.com/d' }] },
  ],
});

test('a good showcase of every block type validates without issues', () => {
  const r = validateShowcase(good());
  assert.deepEqual(r.issues, []);
  assert.ok(r.ok);
  assert.equal(r.showcase!.blocks.length, 11);
  assert.deepEqual(r.showcase!.blocks.map((b) => b.type), [...BLOCK_TYPES]);
  assert.equal(r.showcase!.theme?.accent, 'orange');
  // a video link is stored in its canonical form
  assert.equal((r.showcase!.blocks[0] as { video: string }).video, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
});

test('JSON Schema and validator agree on block types, accents and icons', () => {
  const schema = JSON.parse(readFileSync(new URL('../showcase.schema.json', import.meta.url), 'utf8'));
  const refs = schema.properties.blocks.items.oneOf.map((o: { $ref: string }) => o.$ref.split('/').pop());
  assert.deepEqual(refs, [...BLOCK_TYPES]);
  assert.deepEqual(schema.properties.theme.properties.accent.enum, [...ACCENTS]);
  assert.deepEqual(schema.$defs.features.properties.items.items.properties.icon.enum, [...SHOWCASE_ICONS]);
  assert.equal(schema.properties.blocks.maxItems, SHOWCASE_LIMITS.blocks);
  assert.equal(schema.$defs.markdown, undefined);
  assert.equal(schema.$defs.text.properties.markdown.maxLength, SHOWCASE_LIMITS.markdown);
});

test('bad input: reported, invalid parts dropped, the rest kept', () => {
  const bad = good() as { blocks: unknown[] };
  bad.blocks.push(
    { type: 'script', src: 'x' },
    { type: 'features', items: [{ icon: 'skull', title: 'x', text: 'y' }] },
    { type: 'gallery', images: [{ url: 'http://raw.githubusercontent.com/o/r/a.png' }, { url: 'https://evil.example/a.png' }, { url: 'https://raw.githubusercontent.com/o/r/a.svg' }] },
    { type: 'video', url: 'https://evil.example/watch?v=dQw4w9WgXcQ' },
    { type: 'cta', buttons: [{ kind: 'link', label: 'JS', url: 'javascript:alert(1)' }] },
    { type: 'hero', title: 'Second hero' },
    'nope',
  );
  const r = validateShowcase(bad);
  assert.equal(r.ok, false);
  assert.equal(r.showcase!.blocks.length, 11);
  const paths = r.issues.map((i) => i.path);
  assert.ok(paths.includes('blocks[11].type'));
  assert.ok(paths.includes('blocks[12].items[0].icon'));
  assert.ok(paths.includes('blocks[13].images[0].url'));
  assert.ok(paths.includes('blocks[14].url'));
  assert.ok(paths.includes('blocks[15].buttons[0].url'));
  assert.ok(paths.includes('blocks[16]'));
  assert.ok(paths.includes('blocks[17]'));
});

test('limits: 30 blocks, text lengths, unknown fields, size', () => {
  const many = { version: 1, blocks: Array.from({ length: 31 }, () => ({ type: 'text', markdown: 'x' })) };
  const r = validateShowcase(many);
  assert.equal(r.showcase!.blocks.length, 30);
  assert.ok(r.issues.some((i) => i.path === 'blocks'));
  const long = validateShowcase({ blocks: [{ type: 'hero', title: 'x'.repeat(80), subtitle: 'typo' }] });
  assert.equal((long.showcase!.blocks[0] as { title: string }).title.length, 60);
  assert.ok(long.issues.some((i) => i.path === 'blocks[0].title'));
  assert.ok(long.issues.some((i) => i.path === 'blocks[0].subtitle' && i.message === 'unknown field'));
  assert.equal(validateShowcase({ blocks: [{ type: 'features', items: Array.from({ length: 10 }, () => ({ icon: 'sun', title: 'a', text: 'b' })) }] }).showcase!.blocks[0]!.type, 'features');
  assert.equal(validateShowcase({ blocks: [{ type: 'text', markdown: 'y'.repeat(5000) }] }).ok, false);
  assert.equal(validateShowcase({ blocks: [{ type: 'text', markdown: 'y'.repeat(100_000) }, { type: 'text', markdown: 'y'.repeat(100_000) }] }).showcase, null);
  for (const x of [null, 5, 'x', [], {}, { blocks: 'no' }, { blocks: [] }]) assert.equal(validateShowcase(x).showcase, null);
  assert.equal(validateShowcase({ version: 2, blocks: [{ type: 'text', markdown: 'x' }] }).ok, false);
  assert.equal(validateShowcase({ theme: { accent: 'hotpink' }, blocks: [{ type: 'text', markdown: 'x' }] }).ok, false);
});

test('sanitising: control and bidi characters go, HTML stays inert text, no way to smuggle a tag attribute into data', () => {
  const r = cleanShowcase({ blocks: [{ type: 'hero', title: '<img src=x onerror=alert(1)>‮evil\u0000 title', tagline: 'a\n\nb​' }] })!;
  const h = r.blocks[0] as { title: string; tagline: string };
  assert.ok(!/[‮\u0000​]/.test(h.title + h.tagline));
  assert.equal(h.tagline, 'a b');
  // the text is kept as text (the renderers escape it); the data holds no markup of its own
  assert.ok(h.title.startsWith('<img'));
  assert.equal(cleanShowcase({ blocks: [{ type: 'hero', title: '‮​' }] }), null);
});

test('picture URLs: allowlist of hosts, https, extension, no query or credentials', () => {
  const ok = [
    IMG, 'https://i.imgur.com/abc.jpg', 'https://github.com/o/r/releases/download/v1/shot.webp', 'https://RAW.githubusercontent.com/o/r/main/a.GIF',
  ];
  for (const u of ok) assert.ok(cleanImageUrl(u), u);
  const bad = [
    'http://raw.githubusercontent.com/o/r/a.png', 'https://imgur.com/abc.png', 'https://github.com/o/r/raw/main/a.png', 'https://raw.githubusercontent.com/o/r/a.svg',
    'https://raw.githubusercontent.com/o/r/a.png?x=1', 'https://raw.githubusercontent.com/o/r/a.png#x', 'https://u:p@raw.githubusercontent.com/o/r/a.png', 'data:image/png;base64,AAAA',
    'https://raw.githubusercontent.com:8443/o/r/a.png', 'https://raw.githubusercontent.com.evil.example/a.png', 'javascript:alert(1)', 'https://i.imgur.com/noextension', 5, null,
  ];
  for (const u of bad) assert.equal(cleanImageUrl(u), null, String(u));
  // the hub's own storage host is allowed when the caller names it
  assert.equal(cleanImageUrl('https://files.hub.example/images/abc.jpg'), null);
  assert.ok(cleanImageUrl('https://files.hub.example/images/abc.jpg', { imageHosts: ['files.hub.example'] }));
  assert.equal(cleanImageUrl('https://files.hub.example.evil.test/images/abc.jpg', { imageHosts: ['files.hub.example'] }), null);
});

test('video URLs: YouTube, Vimeo, Streamable in their forms, embedded privacy-friendly', () => {
  const yt = parseVideoUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=5');
  assert.equal(yt?.embed, 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');
  for (const u of ['https://youtu.be/dQw4w9WgXcQ', 'https://youtube.com/embed/dQw4w9WgXcQ', 'https://m.youtube.com/shorts/dQw4w9WgXcQ', 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ']) assert.equal(parseVideoUrl(u)?.id, 'dQw4w9WgXcQ', u);
  assert.equal(parseVideoUrl('https://vimeo.com/123456789')?.embed, 'https://player.vimeo.com/video/123456789?dnt=1');
  assert.equal(parseVideoUrl('https://player.vimeo.com/video/123456789')?.provider, 'vimeo');
  assert.equal(parseVideoUrl('https://streamable.com/abc12')?.embed, 'https://streamable.com/e/abc12');
  assert.equal(parseVideoUrl('https://streamable.com/e/abc12')?.id, 'abc12');
  for (const u of ['http://youtu.be/dQw4w9WgXcQ', 'https://youtube.com.evil.test/watch?v=dQw4w9WgXcQ', 'https://youtube.com/watch?v=short', 'https://vimeo.com/channels/staff', 'https://twitch.tv/x', 'https://youtu.be/dQw4w9WgXcQ"onload="x', 'javascript:alert(1)', 42])
    assert.equal(parseVideoUrl(u), null, String(u));
});

test('markdown: limited subset as a tree, links https only, HTML stays text', () => {
  const t = parseMarkdown('# Head\n\ntext **bold** and *it* and `code`\n\n1. one\n2. two\n\n- a\n- b\n\n```\n<b>raw</b>\n```\n\n<script>alert(1)</script>');
  assert.deepEqual(t.map((b) => b.t), ['h', 'p', 'ol', 'ul', 'pre', 'p']);
  assert.equal((t[0] as { level: number }).level, 3);
  assert.equal((t[4] as { v: string }).v, '<b>raw</b>');
  assert.deepEqual((t[5] as { c: unknown[] }).c, [{ t: 'text', v: '<script>alert(1)</script>' }]);
  const links = parseInline('[ok](https://example.com/a) [js](javascript:alert(1)) [http](http://example.com) [data](data:text/html,x) ![img](https://example.com/a.png)');
  const hrefs = links.filter((n) => n.t === 'a').map((n) => (n as { href: string }).href);
  assert.deepEqual(hrefs, ['https://example.com/a']);
  assert.ok(!links.some((n) => n.t === 'text' && n.v.includes('![')));
  assert.ok(links.some((n) => n.t === 'text' && /js/.test(n.v)));
  assert.deepEqual(parseInline('**a *b* c**'), [{ t: 'b', c: [{ t: 'text', v: 'a ' }, { t: 'i', c: [{ t: 'text', v: 'b' }] }, { t: 'text', v: ' c' }] }]);
  assert.deepEqual(parseInline('snake_case_name'), [{ t: 'text', v: 'snake_case_name' }]);
});

test('showcaseOf finds a catalog showcase by any id or name and cleans it', () => {
  const list = [{ mod: 'TM Vibrant Shaders', showcase: good() }, { mod: 'other', showcase: { blocks: 'x' } }];
  assert.ok(showcaseOf(list, 'tm-vibrant-shaders'));
  assert.ok(showcaseOf(list, 'nope', 'TM Vibrant Shaders'));
  assert.equal(showcaseOf(list, 'other'), null);
  assert.equal(showcaseOf(list, 'missing'), null);
  assert.equal(showcaseOf(undefined, 'x'), null);
});

test('the showcases of the bundled catalog (seed examples) are valid without any issue', () => {
  const cat = JSON.parse(readFileSync(new URL('../../catalog/catalog.json', import.meta.url), 'utf8')) as { showcases: { mod: string; showcase: unknown }[] };
  assert.ok(cat.showcases.length >= 3);
  for (const s of cat.showcases) {
    const r = validateShowcase(s.showcase);
    assert.deepEqual(r.issues, [], s.mod);
    assert.ok(r.ok, s.mod);
  }
});
