import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extImgPath, webImg } from '../src/extimg.ts';

test('extimg: allowlisted hosts map to fixed same-origin paths', () => {
  assert.equal(extImgPath('https://raw.githubusercontent.com/TwinkieTweaks/TwinkieForever/HEAD/Media/tAd.png'), '/ext-img/gh-raw/TwinkieTweaks/TwinkieForever/HEAD/Media/tAd.png');
  assert.equal(extImgPath('https://github.com/o/r/releases/download/v1.2/shot-1.webp'), '/ext-img/gh-rel/o/r/v1.2/shot-1.webp');
  assert.equal(extImgPath('https://github.com/user-attachments/assets/e39cf512-4586-4187-8dbd-8bc588ce553e'), '/ext-img/gh-att/e39cf512-4586-4187-8dbd-8bc588ce553e');
  assert.equal(extImgPath('https://i.imgur.com/AbC123x.jpg'), '/ext-img/imgur/AbC123x.jpg');
  assert.equal(extImgPath('https://tmnf.exchange/trackshow/3726386/image/1'), '/ext-img/tmx/tmnf/3726386/image/1');
  assert.equal(extImgPath('https://original.tm-exchange.com/trackshow/5/thumbnail'), '/ext-img/tmx/original/5/thumbnail');
  assert.equal(extImgPath('https://tmnf.exchange/trackshow/5/thumbnail/../x'), null);
  assert.equal(extImgPath('https://tmnf.exchange/forum/x'), null);
  assert.equal(extImgPath('https://art.gametdb.com/wii/cover/EN/R6RPHH.png'), '/ext-img/gametdb/EN/R6RPHH.png');
  assert.equal(extImgPath('https://art.gametdb.com/wii/cover/EN/../x.png'), null);
  assert.equal(extImgPath('https://images.igdb.com/igdb/image/upload/t_original/co1pa6.webp'), '/ext-img/igdb/co1pa6.webp');
  assert.equal(extImgPath('https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/11020/header.jpg'), '/ext-img/steam/11020/header.jpg');
});

test('extimg: everything else is refused', () => {
  for (const u of [
    'http://raw.githubusercontent.com/o/r/HEAD/a.png', 'https://raw.githubusercontent.com/o/r/HEAD/a.svg',
    'https://raw.githubusercontent.com/o/r/HEAD/a%20b.png', 'https://raw.githubusercontent.com/o/r/HEAD/a.png?x=1', 'https://img.shields.io/badge/a-b-green',
    'https://github.com/o/r/blob/HEAD/a.png', 'https://github.com/o/r/releases/download/v1/setup.exe', 'https://i.imgur.com/a/album.png', 'https://user:pw@i.imgur.com/AbC123x.jpg',
    'https://img.youtube.com/vi/xMwuuWqYHf8/0.jpg', 'javascript:alert(1)', 'not a url',
  ]) assert.equal(extImgPath(u), null, u);
  // dot segments are resolved by the URL parser before the check, never passed on
  assert.equal(extImgPath('https://raw.githubusercontent.com/o/r/HEAD/../x/a.png'), '/ext-img/gh-raw/o/r/x/a.png');
  assert.equal(webImg('/img/covers/eswc-cover.svg'), '/img/covers/eswc-cover.svg');
  assert.equal(webImg('//evil.example/a.png'), null);
  assert.equal(webImg(null), null);
});
