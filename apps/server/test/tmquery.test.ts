// Game port query: the real captures of the launcher's tests (apps/launcher/src-tauri/src/serverquery_vectors.rs,
// MIT, Copyright (c) 2021 OpenGSQ, source github.com/opengsq/opengsq-python) through checksum, LZO and parser,
// plus a fake server on localhost (only with the test flag).
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { acquireSlot, connectionAdmin, decodeMessage, lzo1xDecompress, parseServerInfo, queryServer, queryTestFlags, resetSlots, resolveTarget, stripFormat, QueryError } from '../src/services/tmquery.ts';
import { startFake } from './fake-tm.ts';

const hex = (s: string) => Buffer.from(s, 'hex');
const FOREVER_CLIENT_QUERY_MODE = '0e000000820399f895580700000008000000';
const FOREVER_CLIENT_INFO_REQUEST = '1200000082033bd464400700000007000000d53d4100';
const FOREVER_SERVER_INFO_REPLY = '9b0000008303681ac2009b0000000a0700000006000000d53d41008b5c00000b2d1d641dac2e090900000050432d636539623063050000002353525623500204000106000600094402074b617761626f6e6761075001075374616469756d0100002c6c0001ffffffff940602e09304000178030001080000004230322d526163657a710000b9020079020374040b000040070000005374616469756d110000';
const FOREVER_DEDICATED_SERVER_INFO = '2d0100007f2e090c0000004c4956452d5445535453525605000000235352562300000000000600040017000000246f2466303044474e20246666664c6976652d54657374070000005374616469756d000000001d000000efbbbf4c6976652d54657374204b6f6d6d656e74617220c3a4c3b6c3bc031e0000000f0f000000080000004230312d52616365986c0000a90700080000004230322d526163657a710000b90200080000004230332d52616365767000002105000d0000004230342d4163726f6261746963de350000f60300080000004230352d52616365b26b00000a06000c0000004230362d4f62737461636c65f67200004d0400080000004230372d52616365be7d0000db06000d0000004230382d456e647572616e6365b8a501006f07000d0000004230392d4163726f6261746963163a00000b0600090000004231302d5370656564449d00007a0800080000004231312d52616365a4830000c60700080000004231322d526163658cb90000d104000c0000004231332d4f62737461636c65226a00009d0400090000004231342d537065656476890000480700080000004231352d5261636540ab0000b30700010000000300000000000040070000005374616469756d';
const SUNRISE_CLIENT_QUERY_MODE = '0e00000082038b9433740400000008000000';
const SUNRISE_CLIENT_INFO_REQUEST = '12000000820346e5b853040000000700000034120000';
const SUNRISE_SERVER_INFO_REPLY = '330200008303adf73b18770200000006040000000600000034120000670200000704650a0a2e090f480200074445534b544f502d4a424b4c354a3005000000235352562300600002200020001244020f53756e72697365204c414e2053657276657275031e580708547261636b4d616e696120f0040345787472656d90050401e093040036144408080b0000004e69676874466c75000d580106ee980000ab050000075803054361725061726b0c580203f6900000d104b802045852616365303464040005e83401009d0700000a00000041717561536368656d65095c1005c07f01009f0500006c01064772616e64507269786806053c9b0000720500006c1a03536e616b6508540503d87c00004f06bc08074368616f73204172656168040678690000d50200000e54040b506172616469736549736c616e647c240274d10000f42b590237681105e4b001004907000064170954756e6e656c456666656374600a02fc20010022c80d07536d616c6c2052696e67640505384a0000c203000078200541657269616c204c792273600202a8610000635c07741506446f776e746f776e03402303cecc00004906bc1c075370656564576176650e501502e0a50100b1c0290456696c6c616765781f0286c9000026543e7c0806486170707942617902580502e86e0300a42b250332540d0400e0b00000c707b80b054d61676e697475649c2b0c1e1d0100900500000b000000557020412c207812741f03307500005b032aac060a3502000000722d0100b8070000110000';

beforeEach(() => { queryTestFlags.allowLocal = false; resetSlots(); });
afterEach(() => { queryTestFlags.allowLocal = false; });

test('the two request messages match the game client byte for byte', () => {
  assert.equal(connectionAdmin('forever', 7, 8).toString('hex'), FOREVER_CLIENT_QUERY_MODE);
  assert.equal(connectionAdmin('forever', 7, 7, [0x00413dd5]).toString('hex'), FOREVER_CLIENT_INFO_REQUEST);
  assert.equal(connectionAdmin('sunrise', 4, 8).toString('hex'), SUNRISE_CLIENT_QUERY_MODE);
  assert.equal(connectionAdmin('sunrise', 4, 7, [0x1234]).toString('hex'), SUNRISE_CLIENT_INFO_REQUEST);
});

function infoOf(replyHex: string, v: 'forever' | 'sunrise') {
  const [ty, payload] = decodeMessage(v, hex(replyHex).subarray(4));
  assert.equal(ty, 3);
  assert.equal(payload.readUInt32LE(4), 6, 'subtype 6');
  const n = payload.readUInt32LE(12);
  return parseServerInfo(payload.subarray(16, 16 + n), v);
}

test('real captures: checksum, LZO and parser (TMNF in-game server, Sunrise server)', () => {
  const f = infoOf(FOREVER_SERVER_INFO_REPLY, 'forever');
  assert.deepEqual([f.name, f.hostLogin, f.currentMap, f.maxPlayers], ['Kawabonga', 'PC-ce9b0c', 'B02-Race', 6]);

  assert.equal(f.password, false);
  const s = infoOf(SUNRISE_SERVER_INFO_REPLY, 'sunrise');
  assert.ok(s.name.length > 0 && s.maxPlayers > 0);
  assert.ok(s.currentMap && s.currentMap.length > 0);
});

test('dedicated TMNF server info: name without format codes, comment, current map', () => {
  const i = parseServerInfo(hex(FOREVER_DEDICATED_SERVER_INFO), 'forever');
  assert.equal(i.name, 'DGN Live-Test');
  assert.equal(i.hostLogin, 'LIVE-TESTSRV');
  assert.equal(i.password, false);
  assert.equal(i.currentMap, 'B01-Race');
  assert.equal(i.mode, 'Rounds');
});

test('wrong variant, bad checksum and corrupted LZO are refused', () => {
  assert.throws(() => decodeMessage('sunrise', hex(FOREVER_SERVER_INFO_REPLY).subarray(4)), QueryError);
  const bad = Buffer.from(hex(FOREVER_SERVER_INFO_REPLY).subarray(4));
  bad[5] ^= 1;
  assert.throws(() => decodeMessage('forever', bad), /checksum/);
  assert.throws(() => parseServerInfo(hex(FOREVER_DEDICATED_SERVER_INFO), 'sunrise'), /tag/);
  assert.throws(() => parseServerInfo(hex(FOREVER_DEDICATED_SERVER_INFO).subarray(0, 40), 'forever'), QueryError);
  assert.throws(() => lzo1xDecompress(Buffer.from([22, 1, 2, 3]), 5), /truncated/);
  assert.throws(() => lzo1xDecompress(Buffer.from([18, 97, 0x80, 0, 0x11, 0, 0]), 1 << 30), /too large/);
  // LZO known answers (same as the Rust tests)
  assert.equal(lzo1xDecompress(Buffer.from([22, 104, 101, 108, 108, 111, 0x11, 0, 0]), 5).toString(), 'hello');
  assert.equal(lzo1xDecompress(Buffer.from([18, 97, 0x80, 0, 0x11, 0, 0]), 6).toString(), 'aaaaaa');
});

test('format codes', () => {
  assert.equal(stripFormat('$o$f00DGN $fffLive$$Test$l[http://x]y'), 'DGN Live$Testy');
});

test('address rules: public only, ports 1024-65535, nothing local without the test flag', async () => {
  await assert.rejects(resolveTarget('127.0.0.1:2350'), { kind: 'private' });
  await assert.rejects(resolveTarget('10.0.0.5:2350'), { kind: 'private' });
  await assert.rejects(resolveTarget('192.168.1.1:2350'), { kind: 'private' });
  await assert.rejects(resolveTarget('8.8.8.8:80'), { kind: 'port' });
  await assert.rejects(resolveTarget('8.8.8.8:1023'), { kind: 'port' });
  await assert.rejects(resolveTarget('8.8.8.8:70000'), { kind: 'port' });
  assert.deepEqual(await resolveTarget('8.8.8.8:1024'), { ip: '8.8.8.8', port: 1024 });
  queryTestFlags.allowLocal = true;
  assert.deepEqual(await resolveTarget('127.0.0.1:2350'), { ip: '127.0.0.1', port: 2350 });
});

test('global cap: 30 queries per minute, then busy', async () => {
  for (let i = 0; i < 30; i++) assert.ok(acquireSlot(1_000_000 + i));
  assert.equal(acquireSlot(1_000_100), false);
  assert.ok(acquireSlot(1_000_000 + 61_000));
  resetSlots();
  for (let i = 0; i < 30; i++) assert.ok(acquireSlot());
  await assert.rejects(queryServer('tmnf', '8.8.8.8:2350'), { kind: 'busy' });
});

test('fake servers: forever, legacy, version switch, password flag', async () => {
  queryTestFlags.allowLocal = true;
  const f = await startFake('forever', 'ok', { name: '$o$f00Fake $fffServer', players: 5, max: 32, map: 'A05-Race' });
  const r = await queryServer('tmnf', `127.0.0.1:${f.port}`);
  assert.equal(r.info.name, 'Fake Server');
  assert.deepEqual([r.info.players, r.info.maxPlayers, r.info.currentMap, r.info.mode, r.info.password], [5, 32, 'A05-Race', 'TimeAttack', false]);
  assert.equal(f.connections(), 1, 'one connection');
  await f.close();

  const s = await startFake('sunrise', 'ok', { password: true });
  const rs = await queryServer('tms', `127.0.0.1:${s.port}`);
  assert.equal(rs.info.password, true);
  await s.close();

  const e = await startFake('eswc', 'reject-once');
  const re = await queryServer('eswc', `127.0.0.1:${e.port}`);
  assert.equal(re.info.currentMap, 'A01-Race');
  await e.close();
});

test('fake servers: silent, garbage, bad checksum, wrong game, closed port', async () => {
  queryTestFlags.allowLocal = true;
  const t0 = Date.now();
  const silent = await startFake('forever', 'silent');
  await assert.rejects(queryServer('tmnf', `127.0.0.1:${silent.port}`), { kind: 'timeout' });
  assert.ok(Date.now() - t0 < 4500, 'within the 3 s limit');
  assert.ok(silent.connections() <= 2, 'at most one retry');
  await silent.close();
  const g = await startFake('forever', 'garbage');
  await assert.rejects(queryServer('tmnf', `127.0.0.1:${g.port}`), QueryError);
  await g.close();
  const b = await startFake('forever', 'badsum');
  await assert.rejects(queryServer('tmnf', `127.0.0.1:${b.port}`), /checksum/);
  await b.close();
  // a Sunrise server asked as TMNF: checksum key differs
  const w = await startFake('sunrise', 'ok');
  await assert.rejects(queryServer('tmnf', `127.0.0.1:${w.port}`), QueryError);
  await w.close();
  await assert.rejects(queryServer('tmnf', '127.0.0.1:1999'), QueryError);
});
