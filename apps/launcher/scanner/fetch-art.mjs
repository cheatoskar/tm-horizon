// Store art per title: cover (600x900), hero (wide) and logo.
// 1) Local Steam library cache (appcache\librarycache\<appid>\...), like other launchers.
// 2) Steam CDN by app id (ids verified with the public appdetails API).
// Titles without a Steam page get a typographic tile in the UI.
// Writes public/store-art/<titleId>/{cover.jpg,hero.jpg,logo.png} and src/generated/art.json.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, '..', 'public', 'store-art');
const outJson = path.join(here, '..', 'src', 'generated', 'art.json');
const UA = 'TM-Horizon-scanner (+https://tm-horizon.com)';
const PF86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
const CACHE = path.join(PF86, 'Steam', 'appcache', 'librarycache');

const STEAM = {
  tmnf: 11020, tmuf: 7200, 'tm2-canyon': 228760, 'tm2-stadium': 232910, 'tm2-valley': 243360,
  'tm2-lagoon': 600720, 'sm-storm': 229870, 'tm-turbo': 375900, tm2020: 2225070,
};
const FILES = { cover: 'library_600x900.jpg', hero: 'library_hero.jpg', logo: 'logo.png' };
const HOSTS = [
  'https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps',
  'https://cdn.cloudflare.steamstatic.com/steam/apps',
];

function curl(url, binary) {
  // curl.exe ships with Windows; Node's fetch timed out on some hosts here.
  const buf = execFileSync('curl', ['-sfL', '-m', '30', '-A', UA, url], { maxBuffer: 64 << 20 });
  return binary ? buf : JSON.parse(buf.toString('utf8'));
}

const result = {};
for (const [title, appid] of Object.entries(STEAM)) {
  const entry = { appid, steamName: null, verified: false, files: {} };
  try {
    const d = curl(`https://store.steampowered.com/api/appdetails?appids=${appid}&filters=basic`, false)[appid];
    entry.verified = !!d?.success;
    entry.steamName = d?.data?.name ?? null;
  } catch (e) { entry.error = 'appdetails: ' + e.message; }
  const dir = path.join(outDir, title);
  fs.mkdirSync(dir, { recursive: true });
  for (const [kind, file] of Object.entries(FILES)) {
    const dest = path.join(dir, kind + path.extname(file));
    const local = path.join(CACHE, String(appid), file);
    if (fs.existsSync(local)) {
      fs.copyFileSync(local, dest);
      entry.files[kind] = { path: `store-art/${title}/${path.basename(dest)}`, source: `Steam library cache (librarycache\\${appid}\\${file})` };
      continue;
    }
    for (const h of HOSTS) {
      const url = `${h}/${appid}/${file}`;
      try {
        fs.writeFileSync(dest, curl(url, true));
        entry.files[kind] = { path: `store-art/${title}/${path.basename(dest)}`, source: url };
        break;
      } catch { /* try next host */ }
    }
  }
  result[title] = entry;
  console.log(title, appid, entry.verified ? 'ok' : 'NOT VERIFIED', entry.steamName ?? '', Object.keys(entry.files).join(','));
}
// Titles without Steam art (Original, ESWC, Sunrise: box scans added by hand) stay as they are.
const old = fs.existsSync(outJson) ? JSON.parse(fs.readFileSync(outJson, 'utf8')).titles ?? {} : {};
for (const [title, entry] of Object.entries(old)) if (!(title in result)) result[title] = entry;
fs.writeFileSync(outJson, JSON.stringify({ fetchedAt: new Date().toISOString(), titles: result }, null, 2));
