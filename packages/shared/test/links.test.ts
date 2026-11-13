import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanRelatedLinks, cleanHttpsUrl } from '../src/links.ts';

test('related links: https and known kinds only, companion first, no duplicates', () => {
  const l = cleanRelatedLinks([
    { kind: 'docs', label: 'Docs', url: 'https://example.com/d' },
    { kind: 'companion', label: ' Bingo  board ', url: 'https://example.com/b' },
    { kind: 'docs', label: 'Again', url: 'https://example.com/d' },
    { kind: 'docs', label: 'Plain http', url: 'http://example.com/x' },
    { kind: 'forum', label: 'Unknown kind', url: 'https://example.com/f' },
    { kind: 'source', label: 'Creds', url: 'https://user:pw@example.com/' },
    { kind: 'website', label: '', url: 'https://example.com/' },
    { kind: 'website', label: 'JS', url: 'javascript:alert(1)' },
    null, 'x', 5,
  ]);
  assert.deepEqual(l.map((x) => [x.kind, x.label]), [['companion', 'Bingo board'], ['docs', 'Docs']]);
  assert.deepEqual(cleanRelatedLinks('nope'), []);
  assert.equal(cleanRelatedLinks(Array.from({ length: 20 }, (_, i) => ({ kind: 'docs', label: 'd', url: `https://example.com/${i}` }))).length, 8);
  assert.equal(cleanHttpsUrl('https://localhost/'), null);
});
