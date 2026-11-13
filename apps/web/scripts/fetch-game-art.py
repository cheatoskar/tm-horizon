"""Download official store art for every title into public/img/games/ and write SOURCES.md.

Run: python scripts/fetch-game-art.py   (needs Pillow; set PYTHONIOENCODING=utf-8 on Windows)

Steam titles: Steam's public library assets by app id (ids checked against
store.steampowered.com/api/appdetails on 2026-11-10). Titles that were never on Steam: the box art
on their English Wikipedia articles (non-free, fair use there).
Local prototype only: for a public site load these from the store CDN at runtime or clear them with
the rights holder (Ubisoft / Nadeo). Do not rehost.
"""
import io, os, sys, time, urllib.request
from PIL import Image

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
OUT = os.path.join(ROOT, 'public', 'img', 'games')
os.makedirs(OUT, exist_ok=True)
UA = {'User-Agent': 'TM-Horizon-site (+https://tm-horizon.com)'}
CDN = 'https://cdn.cloudflare.steamstatic.com/steam/apps/{}/{}'

STEAM = {  # game id: (Steam app id, store name)
    'tmnf': (11020, 'TrackMania Nations Forever'),
    'tmuf': (7200, 'Trackmania United Forever'),
    'tm2-canyon': (228760, 'TrackMania² Canyon'),
    'tm2-stadium': (232910, 'TrackMania² Stadium'),
    'tm2-valley': (243360, 'TrackMania² Valley'),
    'tm2-lagoon': (600720, 'Trackmania² Lagoon'),
    'sm-storm': (229870, 'ShootMania Storm'),
    'turbo': (375900, 'Trackmania® Turbo'),
    'tm2020': (2225070, 'Trackmania'),
}
# Box covers for games without Steam art (tmo, tms, eswc) are made by hand from box scans
# (my own scans for ESWC and Sunrise, archive.org for Original) and are not fetched here.
# This script leaves their files alone and keeps their rows in SOURCES.md.
BOX_ROWS = [
    '| tmo | Box art (PC CD-ROM, Nadeo / Focus) | Box scan on archive.org; matches the owner-supplied box scan | https://archive.org/details/TMORIGINAL | https://archive.org/download/TMORIGINAL/TrackMania-Original-Cover.jpg | Copyrighted box art, no licence: local test build only; clear rights before a public release. | `tmo-cover.webp` 600x836 |',
    '| tms | Box art (Deep Silver edition), Nadeo | Owner-supplied box scan, 2026-11-10 | - | `tms.jpg` 461x664 | Copyrighted box art, no licence: local test build only; clear rights before a public release. | `tms-cover.webp` 461x664 |',
    '| eswc | Box art, Nadeo / Focus | Owner-supplied box scan, 2026-11-10 | - | `eswc.jpg` 574x800 | Copyrighted box art, no licence: local test build only; clear rights before a public release. | `eswc-cover.webp` 574x800 |',
]


def get(url):
    for i in range(4):
        try:
            return urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30).read()
        except Exception as e:  # Wikimedia answers 429 when asked too fast
            if i == 3:
                raise
            time.sleep(3 * (i + 1))


def save(img, name, width=None, quality=82):
    if width and img.width > width:
        img = img.resize((width, round(img.height * width / img.width)), Image.LANCZOS)
    path = os.path.join(OUT, name)
    img.save(path, 'WEBP', quality=quality, method=6)
    return img.size, os.path.getsize(path) // 1024


rows = []
for gid, (app, store) in STEAM.items():
    made = []
    for src, name, conv, width in [
        ('library_600x900_2x.jpg', f'{gid}-cover.webp', 'RGB', 600),
        ('library_hero.jpg', f'{gid}-hero.webp', 'RGB', 1920),
        ('header.jpg', f'{gid}-header.webp', 'RGB', 460),
        ('logo.png', f'{gid}-logo.webp', 'RGBA', 640),
    ]:
        try:
            im = Image.open(io.BytesIO(get(CDN.format(app, src)))).convert(conv)
            if conv == 'RGBA':  # logos come with wide transparent margins
                im = im.crop(im.getchannel('A').point(lambda a: 255 if a > 8 else 0).getbbox())
        except Exception as e:
            print('missing', gid, src, e)
            continue
        size, kb = save(im, name, width, 80 if name.endswith('hero.webp') else 85)
        made.append(f'`{name}` {size[0]}x{size[1]}')
        print(gid, name, size, kb, 'KB')
    rows.append((gid, store, f'Steam app {app}', f'https://store.steampowered.com/app/{app}/',
                 'Steam library assets (`library_600x900_2x.jpg`, `library_hero.jpg`, `header.jpg`, `logo.png`) from `cdn.cloudflare.steamstatic.com/steam/apps/%d/`' % app,
                 'Copyright Ubisoft / Nadeo. Store marketing art, not licensed for reuse.', ', '.join(made)))

with open(os.path.join(OUT, 'SOURCES.md'), 'w', encoding='utf-8', newline='\n') as f:
    f.write('# Game art sources\n\n')
    f.write('Official store and box art, fetched by `scripts/fetch-game-art.py` on %s for the local prototype only.\n' % time.strftime('%Y-%m-%d'))
    f.write('None of it is licensed for reuse. Before anything is published, either load these from the Steam CDN\n')
    f.write('at runtime (hotlink the URLs below) or get permission from Ubisoft / Nadeo. Do not rehost.\n\n')
    f.write('| Game | Title / credit | Source | Page | Original file | Licence | Files here |\n|---|---|---|---|---|---|---|\n')
    for r in rows:
        f.write('| ' + ' | '.join(r) + ' |\n')
    for line in BOX_ROWS:
        f.write(line + '\n')
print('wrote SOURCES.md')
