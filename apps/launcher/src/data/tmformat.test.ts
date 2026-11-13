import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTm, stripTm, tmLength, tmWarnings, TM_COLORS } from './tmformat.ts';

const texts = (s: string) => parseTm(s).map((x) => x.text);

test('empty string', () => {
  assert.deepEqual(parseTm(''), []);
  assert.equal(stripTm(''), '');
  assert.equal(tmLength(''), 0);
});
test('plain text has default style', () => {
  assert.deepEqual(parseTm('abc'), [{ text: 'abc', color: null, bold: false, italic: false, wide: false, narrow: false, shadow: false, upper: false, link: null }]);
});
test('rgb colour', () => {
  const s = parseTm('a$f00b');
  assert.equal(s.length, 2);
  assert.equal(s[1].color, '#f00');
  assert.equal(s[1].text, 'b');
});
test('uppercase colour code is lowercased', () => {
  assert.equal(parseTm('$F0Ax')[0].color, '#f0a');
});
test('partial hex pads with 0', () => {
  const s = parseTm('$f0x');
  assert.equal(s[0].color, '#f00');
  assert.equal(s[0].text, 'x');
  assert.deepEqual(tmWarnings('$f0x'), ['bad-color']);
  assert.equal(parseTm('$ax')[0].color, '#a00');
});
test('only three hex digits are consumed', () => {
  const s = parseTm('$f00abc');
  assert.equal(s[0].color, '#f00');
  assert.equal(s[0].text, 'abc');
});
test('bold and italic, upper case codes', () => {
  assert.equal(parseTm('$oX')[0].bold, true);
  assert.equal(parseTm('$OX')[0].bold, true);
  assert.equal(parseTm('$IX')[0].italic, true);
});
test('wide and narrow cancel each other', () => {
  assert.equal(parseTm('$wa')[0].wide, true);
  const s = parseTm('$w$na')[0];
  assert.equal(s.narrow, true);
  assert.equal(s.wide, false);
  const t = parseTm('$n$wa')[0];
  assert.equal(t.wide, true);
  assert.equal(t.narrow, false);
});
test('$m resets width only', () => {
  const s = parseTm('$o$wa$mb');
  assert.equal(s[1].wide, false);
  assert.equal(s[1].bold, true);
});
test('shadow and uppercase flags', () => {
  const s = parseTm('$s$ta')[0];
  assert.equal(s.shadow, true);
  assert.equal(s.upper, true);
});
test('$g resets colour only', () => {
  const s = parseTm('$f00$oa$gb');
  assert.equal(s[1].color, null);
  assert.equal(s[1].bold, true);
});
test('$z resets everything', () => {
  const s = parseTm('$f00$o$i$w$s$t$za');
  assert.deepEqual(s.length, 1);
  assert.equal(s[0].color, null);
  assert.equal(s[0].bold || s[0].italic || s[0].wide || s[0].shadow || s[0].upper, false);
});
test('$z after everything on a later run', () => {
  const s = parseTm('$f00$oa$zb');
  assert.equal(s[1].color, null);
  assert.equal(s[1].bold, false);
});
test('$$ is a literal dollar', () => {
  assert.equal(stripTm('a$$b'), 'a$b');
  assert.equal(stripTm('$$f00'), '$f00');
});
test('$$ inside a colour run keeps the colour and merges', () => {
  const s = parseTm('$f00a$$b');
  assert.equal(s.length, 1);
  assert.equal(s[0].text, 'a$b');
  assert.equal(s[0].color, '#f00');
});
test('unknown code is dropped', () => {
  assert.equal(stripTm('a$xb'), 'ab');
  assert.equal(stripTm('a$!b'), 'ab');
});
test('lone trailing dollar is dropped', () => {
  assert.equal(stripTm('abc$'), 'abc');
  assert.deepEqual(tmWarnings('abc$'), ['trailing-dollar']);
});
test('push and pop restore the style', () => {
  const s = parseTm('$f00$o$<$0f0$ia$>b');
  assert.equal(s[0].color, '#0f0');
  assert.equal(s[0].italic, true);
  assert.equal(s[1].color, '#f00');
  assert.equal(s[1].bold, true);
  assert.equal(s[1].italic, false);
});
test('nested push and pop', () => {
  const s = parseTm('$<$f00$<$0f0a$>b$>c');
  assert.deepEqual(s.map((x) => x.color), ['#0f0', '#f00', null]);
});
test('unbalanced push and pop warn', () => {
  assert.deepEqual(tmWarnings('$<a'), ['unbalanced-push']);
  assert.deepEqual(tmWarnings('a$>'), ['unbalanced-push']);
  assert.deepEqual(tmWarnings('$<a$>'), []);
});
test('link with brackets', () => {
  const s = parseTm('x$l[http://a.b]click$lafter');
  assert.deepEqual(texts('x$l[http://a.b]click$lafter'), ['x', 'click', 'after']);
  assert.equal(s[1].link, 'http://a.b');
  assert.equal(s[2].link, null);
});
test('link without brackets uses its text as url', () => {
  const s = parseTm('a$lexample.com');
  assert.equal(s[1].text, 'example.com');
  assert.equal(s[1].link, 'example.com');
  assert.equal(s[0].link, null);
  // a bare $l ends the open link (toggle)
  const t = parseTm('$lone$ltwo');
  assert.deepEqual(t.map((x) => x.link), ['one', null]);
});
test('link ends at the next $h or $p', () => {
  const s = parseTm('$l[u]a$h[m]b$p[q]c');
  assert.deepEqual(s.map((x) => x.link), ['u', 'm', 'q']);
});
test('link keeps style changes inside the text', () => {
  const s = parseTm('$l[u]a$f00b');
  assert.equal(s.length, 2);
  assert.equal(s[1].link, 'u');
  assert.equal(s[1].color, '#f00');
});
test('unclosed bracket warns', () => {
  assert.deepEqual(tmWarnings('$l[abc'), ['open-link']);
});
test('stripTm and tmLength', () => {
  assert.equal(stripTm('$o$f00Hi$z there$$'), 'Hi there$');
  assert.equal(tmLength('$o$f00Hi$z there$$'), 9);
});
test('TM_COLORS are valid codes', () => {
  for (const c of TM_COLORS) assert.match(c.code, /^\$[0-9a-f]{3}$/);
});
