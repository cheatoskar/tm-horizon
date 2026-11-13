import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IGDB_COVERS, igdbCoverPath, igdbCoverUrl } from '../src/covers.ts';

test('covers: launcher and website ids find the same IGDB picture', () => {
  assert.equal(igdbCoverPath('tmn-eswc'), igdbCoverPath('eswc'));
  assert.equal(igdbCoverPath('tm-sunrise'), 't_original/co1v1p.webp');
  assert.equal(igdbCoverPath('tm-original'), 't_original/co6k83.webp');
  assert.equal(igdbCoverPath('tm-turbo'), igdbCoverPath('turbo'));
  assert.equal(igdbCoverUrl('tmnf'), 'https://images.igdb.com/igdb/image/upload/t_original/co1pa6.webp');
  assert.equal(igdbCoverUrl('sm-storm'), null);
});

test('covers: every path is a plain IGDB image (size/id.ext), safe for the /ext-img proxy', () => {
  for (const p of Object.values(IGDB_COVERS)) assert.match(p, /^t_(original|cover_big|cover_big_2x)\/[a-z0-9]+\.(webp|jpg|png)$/);
});
