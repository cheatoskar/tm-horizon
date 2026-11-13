// npm run record-fixtures: record small real responses into test/fixtures/ for the parser tests.
// Reuses the build cache where it can (GitHub especially, to save the anonymous rate limit).
// Discord needs a bot token, so test/fixtures/discord-events.json is written by hand after the
// documented example (https://discord.com/developers/docs/resources/guild-scheduled-event) and left alone here.
import fs from 'node:fs';
import path from 'node:path';
import { Http } from '../src/lib/http.ts';
import { loadConfig } from '../src/config.ts';

const root = path.resolve(import.meta.dirname, '..');
const out = path.join(root, 'test', 'fixtures');
fs.mkdirSync(out, { recursive: true });
const config = loadConfig(path.join(root, 'config', 'hub.config.json'));
const http = new Http(path.join(root, '.cache'), config.userAgent);
const week = 7 * 24 * 60;
const gh = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };

const save = (name: string, data: unknown) => {
  fs.writeFileSync(path.join(out, name), JSON.stringify(data, null, 2) + '\n');
  console.log('wrote', name);
};
const get = async (url: string, headers: Record<string, string> = {}) => (await http.getJson<any>(url, { ttlMinutes: week, headers })).data;

const cut = (s: unknown, n: number) => (typeof s === 'string' && s.length > n ? s.slice(0, n) + '...' : s);

// TMLoader repositories: one big (TMVS, changelogs shortened), two small, plus the masterserver.
const tmvs = await get('https://cheatoskar.github.io/TM-Vibrant-Shaders/modloader/index.json');
for (const p of Object.values<any>(tmvs.products)) for (const v of Object.values<any>(p.versions)) v.changelog = cut(v.changelog, 300);
save('modloader-tmvs.json', tmvs);
save('modloader-donadigo.json', await get('https://donadigo.com/modloader/index.json'));
save('modloader-fullspeed.json', await get('https://fullspeed.mooo.com/modloader/index.json'));
const tomashu = await get('https://modloader.tomashu.dev/modloader/TmForever/v1/index.json');
for (const p of Object.values<any>(tomashu.products)) {
  p.versions = Object.fromEntries(Object.entries<any>(p.versions).slice(0, 3));
  for (const v of Object.values<any>(p.versions)) v.changelog = cut(v.changelog, 300);
}
save('modloader-tomashu.json', tomashu);
const master = await get('https://modloader.tomashu.dev/modloader/v1/index.json');
master.versions = Object.fromEntries(Object.entries<any>(master.versions ?? {}).slice(0, 1));
save('modloader-master.json', master);

// GitHub: one repository with releases, one without.
save('github-repo-gbx-net.json', await get('https://api.github.com/repos/BigBang1112/gbx-net', gh));
const rel = await get('https://api.github.com/repos/BigBang1112/gbx-net/releases?per_page=10', gh);
const keepRelease = ({ tag_name, name, draft, prerelease, published_at, html_url, body, assets }: any) => ({
  tag_name, name, draft, prerelease, published_at, html_url, body: cut(body, 400),
  assets: assets.map(({ name, size, browser_download_url, download_count, content_type }: any) => ({ name, size, browser_download_url, download_count, content_type })),
});
save('github-releases-gbx-net.json', rel.slice(0, 3).map(keepRelease));
save('github-repo-evosc.json', await get('https://api.github.com/repos/EvoEsports/EvoSC', gh));

// TMX: a track site and a map site, three results each.
save('tmx-tmnf-tracks.json', await get('https://tmnf.exchange/api/tracks?fields=TrackId%2CTrackName%2CUploader.Name%2CAuthors%2CAwards%2CUploadedAt%2CEnvironment%2CHasThumbnail&count=3&order1=26'));
save('tmx-tm2-maps.json', await get('https://tm.mania.exchange/api/maps?fields=MapId%2CName%2CUploader.Name%2CAuthors%2CAwardCount%2CUploadedAt%2CTitlePack%2CHasThumbnail&count=3&order1=40&titlepack=TMStadium'));

// Servers.
save('maniaplanet-servers.json', await get('https://www.maniaplanet.com/webservices/servers/online?length=5&offset=0'));
const rooms = await get('https://trackmania.io/api/rooms/0');
save('tmio-rooms.json', { ...rooms, rooms: rooms.rooms.slice(0, 5) });

// Catalog: the first entries of the sibling catalog.
const catFile = path.resolve(root, '..', 'catalog', 'catalog.json');
if (fs.existsSync(catFile)) {
  const cat = JSON.parse(fs.readFileSync(catFile, 'utf8'));
  const pick = cat.entries.filter((e: any) => /github\.com/.test(e.url)).slice(0, 3);
  save('catalog.json', { updated: cat.updated, entries: [...cat.entries.slice(0, 5), ...pick] });
}
http.save();
console.log('requests:', http.totalRequests());
