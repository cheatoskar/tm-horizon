"""Converts the TMX 2022 Headers Contest art (owner-supplied, local/preview only) to webp.

Usage: python scanner/import-header-art.py "<...>/2022 TMX Headers Contest" [--nations-dir <Downloads>]
Writes public/header-art/*.webp, src/generated/header-art.json and ../../ART_CREDITS.md.
The source images are only read, never moved or changed.
"""
import json
import os
import sys
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', 'public', 'header-art')
MANIFEST = os.path.join(HERE, '..', 'src', 'generated', 'header-art.json')
CREDITS = os.path.join(HERE, '..', '..', '..', 'ART_CREDITS.md')

# site host -> (artist, day source, night source), relative to the contest folder.
# Only TMNF-X and TMUF-X have contest banners; there is nothing for the other exchanges.
BANNERS = {
    'tmnf.exchange': ('shortz', 'Headers/TMNF/shortz1-day.png', 'Headers/TMNF/shortz1-night.png'),
    'tmuf.exchange': ('Dule', 'Headers/United/Bay/Dule-Bay-Day.png', 'Headers/United/Bay/Dule-Bay-Night.png'),
}
# environment -> (day, night) full backgrounds by Dule
ENVS = {
    'bay': ('Headers/Dule-BayDayBG.jpg', 'Headers/Dule-BayNightBG.jpg'),
    'coast': ('Headers/Dule-CoastDayBG.jpg', 'Headers/Dule-CoastNightBG.jpg'),
    'desert': ('Headers/Dule-DesertDayBG.jpg', 'Headers/Dule-DesertNightBG.jpg'),
    'island': ('Headers/Dule-IslandDayBG.jpg', 'Headers/DuleIslandNightBG.jpg'),
    'rally': ('Headers/Dule-RallyDayBG.jpg', 'Headers/Dule-RallyNightBG.jpg'),
    'snow': ('Headers/Dule-SnowDayBG.jpg', 'Headers/Dule-SnowNightBG.jpg'),
    'stadium': ('Headers/Dule-StadiumDayBG.jpg', 'Headers/Dule-StadiumNightBG.jpg'),
}
# Nations ESWC (task 2): copied from Downloads, converted to jpg for the launcher's store-art
NATIONS_HERO_SRC = 'f3c0623d-a102-4359-8352-0484145c49cc.9f9beb42-4636-4252-9e55-f3459a06cde3.jpeg'


def save(im, name, q, w, h=None):
    im = im.convert('RGB')
    if h is None:
        h = round(im.height * w / im.width)
        im = im.resize((w, h), Image.LANCZOS)
    else:  # center crop to the target aspect, then scale
        r = w / h
        cw, ch = (im.width, round(im.width / r)) if im.width / im.height < r else (round(im.height * r), im.height)
        x, y = (im.width - cw) // 2, (im.height - ch) // 2
        im = im.crop((x, y, x + cw, y + ch)).resize((w, h), Image.LANCZOS)
    p = os.path.join(OUT, name)
    im.save(p, 'WEBP', quality=q, method=6)
    return os.path.getsize(p)


def main():
    src = sys.argv[1]
    os.makedirs(OUT, exist_ok=True)
    manifest = {'sites': {}, 'envs': {}}
    credits = []
    total = 0
    for host, (artist, d, n) in BANNERS.items():
        key = host.split('.')[0]
        files = {}
        for variant, rel in (('day', d), ('night', n)):
            name = f'banner-{key}-{variant}.webp'
            total += save(Image.open(os.path.join(src, rel)), name, 80, 1960)
            files[variant] = 'header-art/' + name
            credits.append((name, artist, rel))
        manifest['sites'][host] = {**files, 'artist': artist}
    for env, (d, n) in ENVS.items():
        files = {}
        for variant, rel in (('day', d), ('night', n)):
            name = f'env-{env}-{variant}.webp'
            total += save(Image.open(os.path.join(src, rel)), name, 72, 1920, 1080)
            files[variant] = 'header-art/' + name
            credits.append((name, 'Dule', rel))
        name = f'env-{env}-small.webp'
        total += save(Image.open(os.path.join(src, d)), name, 60, 480, 270)
        files['small'] = 'header-art/' + name
        credits.append((name, 'Dule', d + ' (480 px version)'))
        manifest['envs'][env] = {**files, 'artist': 'Dule'}
    os.makedirs(os.path.dirname(MANIFEST), exist_ok=True)
    with open(MANIFEST, 'w', encoding='utf8', newline='\n') as f:
        json.dump(manifest, f, indent=2)
        f.write('\n')
    lines = ['# Art credits', '',
             '## TMX Headers Contest 2022', '',
             'Header banners and environment backgrounds from the TMX Headers Contest 2022, converted to webp by',
             '`apps/launcher/scanner/import-header-art.py` into `apps/launcher/public/header-art/`.', '',
             '**local/preview only until TMX and the artists agree — ask before a public release.**',
             'The images are not part of the website (`apps/web`).', '',
             '| Converted file | Artist | Source file (in "2022 TMX Headers Contest") |', '|---|---|---|']
    lines += [f'| `{n}` | {a} | `{s}` |' for n, a, s in credits]
    lines += ['', '## Nations ESWC (launcher tile and hero)', '',
              '- `apps/launcher/public/store-art/tmn-eswc/hero.jpg`: owner-supplied screenshot of the ESWC start grid, source file',
              f'  `{NATIONS_HERO_SRC}` (Downloads folder, original author unknown). Copyrighted game screenshot, local test build only.',
              '- `apps/launcher/public/store-art/tmn-eswc/cover.jpg`: owner-supplied box scan (unchanged).',
              '- Not used: `trackmanianations.jpg` (640x480, too small for a hero) and `3404239_original.jpg` (it shows',
              '  TrackMania Sunrise, not Nations).', '']
    with open(CREDITS, 'w', encoding='utf8', newline='\n') as f:
        f.write('\n'.join(lines))
    print('files', len(credits), 'total KB', total // 1024)


main()
