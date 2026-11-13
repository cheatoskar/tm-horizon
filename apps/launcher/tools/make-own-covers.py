"""Own covers from my own in-game screenshots (e.g. TMVS photos) for Nations ESWC, Sunrise and Original.

Drop the screenshots into apps/launcher/public/covers-own/drop/ named
    eswc-cover.jpg  eswc-hero.jpg  tms-cover.png  tmo-hero.webp ...   (jpg, png or webp, any size)
and run (from the repo root):
    python -I apps/launcher/tools/make-own-covers.py

It writes, in our style (dark fade, speed stripes, the game name in Barlow Semi Condensed like the
designed covers):
    apps/launcher/public/covers-own/<launcher id>-cover.jpg   600x900, with the game name
    apps/launcher/public/covers-own/<launcher id>-hero.jpg    1920x620, fade only (the page puts the name on it)
    apps/web/public/img/covers-own/<site id>-cover.jpg / -hero.jpg   the same files for the website
    apps/launcher/src/generated/covers-own.json   which games have one (the launcher reads this)
Games without a screenshot keep today's look (official IGDB/Steam cover or the designed one). An empty
drop folder removes all composed files again. The drop folder itself never ships (vite.config.ts).
"""
import json
import os
import sys

from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageOps

HERE = os.path.dirname(os.path.abspath(__file__))
LAUNCHER = os.path.dirname(HERE)
REPO = os.path.dirname(os.path.dirname(LAUNCHER))
DROP = os.path.join(LAUNCHER, 'public', 'covers-own', 'drop')
OUT = os.path.join(LAUNCHER, 'public', 'covers-own')
WEB_OUT = os.path.join(REPO, 'apps', 'web', 'public', 'img', 'covers-own')
MANIFEST = os.path.join(LAUNCHER, 'src', 'generated', 'covers-own.json')

# drop name -> launcher id, website id, title lines, year, accent (same colours as apps/web/scripts/make-covers.mjs)
GAMES = {
    'eswc': ('tmn-eswc', 'eswc', ['NATIONS', 'ESWC'], '2006', (143, 180, 255)),
    'tms': ('tm-sunrise', 'tms', ['SUNRISE'], '2005', (255, 211, 138)),
    'tmo': ('tm-original', 'tmo', ['ORIGINAL'], '2005', (207, 231, 255)),
}
SIZES = {'cover': (600, 900), 'hero': (1920, 620)}


def font(size, weight='700'):
    name = f'barlow-semi-condensed-latin-{weight}-normal.woff'
    d = LAUNCHER
    for _ in range(6):
        p = os.path.join(d, 'node_modules', '@fontsource', 'barlow-semi-condensed', 'files', name)
        if os.path.isfile(p):
            return ImageFont.truetype(p, size)
        d = os.path.dirname(d)
    for p in (r'C:\Windows\Fonts\bahnschrift.ttf', r'C:\Windows\Fonts\arialbd.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'):
        if os.path.isfile(p):
            return ImageFont.truetype(p, size)
    return ImageFont.load_default()


def stripes(w, h, accent):
    """Long thin bars rotated like the mod icons' speed stripes (white, fading to the right)."""
    layer = Image.new('RGBA', (w * 2, h * 2), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    for x, y, l, t in [(-0.2, 0.18, 1.5, 0.012), (0.1, 0.27, 1.2, 0.006), (0.3, 0.71, 1.1, 0.009), (-0.1, 0.82, 0.8, 0.005)]:
        x0, y0 = int((x + 0.5) * w), int((y + 0.5) * h)
        th = max(3, int(t * h))
        for i in range(int(l * w)):
            a = int(60 * i / max(1, l * w))
            d.line([(x0 + i, y0), (x0 + i, y0 + th)], fill=(255, 255, 255, a))
    layer = layer.rotate(24, resample=Image.BICUBIC)
    return layer.crop((w // 2, h // 2, w // 2 + w, h // 2 + h))


def fade(w, h, top=0.35, power=1.4):
    """Black fade from `top` down to the bottom edge (the title sits on it)."""
    g = Image.new('L', (1, h))
    for y in range(h):
        k = max(0.0, (y / h - top) / (1 - top))
        g.putpixel((0, y), int(235 * k ** power))
    mask = g.resize((w, h))
    return Image.merge('RGBA', (Image.new('L', (w, h), 0),) * 3 + (mask,))


def compose(src, kind, game):
    _, _, lines, year, accent = GAMES[game]
    w, h = SIZES[kind]
    im = ImageOps.fit(Image.open(src).convert('RGB'), (w, h), Image.LANCZOS, centering=(0.5, 0.45)).convert('RGBA')
    im = Image.alpha_composite(im, stripes(w, h, accent))
    im = Image.alpha_composite(im, fade(w, h, 0.25, 0.9) if kind == 'cover' else fade(w, h, 0.45))
    if kind == 'cover':
        d = ImageDraw.Draw(im)
        big = font(96)
        small = font(26, '600')
        y = int(h * 0.66)
        shadow = Image.new('RGBA', (w, h), (0, 0, 0, 0))
        sd = ImageDraw.Draw(shadow)
        for i, line in enumerate(lines):
            tw = d.textlength(line, font=big)
            sd.text(((w - tw) / 2, y + 6 + i * 92), line, font=big, fill=(0, 0, 0, 170))
        im = Image.alpha_composite(im, shadow.filter(ImageFilter.GaussianBlur(14)))
        d = ImageDraw.Draw(im)
        kicker = 'T R A C K M A N I A'
        d.text(((w - d.textlength(kicker, font=small)) / 2, y - 40), kicker, font=small, fill=(255, 255, 255, 200))
        for i, line in enumerate(lines):
            tw = d.textlength(line, font=big)
            d.text(((w - tw) / 2, y + i * 92), line, font=big, fill=(255, 255, 255, 255))
        yy = ' '.join(year)
        d.text(((w - d.textlength(yy, font=small)) / 2, y + len(lines) * 92 + 14), yy, font=small, fill=accent + (235,))
    return im.convert('RGB')


def main():
    os.makedirs(DROP, exist_ok=True)
    manifest = {}
    wanted = set()
    for f in sorted(os.listdir(DROP)):
        base, ext = os.path.splitext(f)
        if ext.lower() not in ('.jpg', '.jpeg', '.png', '.webp') or '-' not in base:
            continue
        game, kind = base.lower().rsplit('-', 1)
        if game not in GAMES or kind not in SIZES:
            print('skipped (name must be eswc|tms|tmo-cover|hero):', f)
            continue
        lid, sid = GAMES[game][0], GAMES[game][1]
        im = compose(os.path.join(DROP, f), kind, game)
        for folder, name in ((OUT, f'{lid}-{kind}.jpg'), (WEB_OUT, f'{sid}-{kind}.jpg')):
            os.makedirs(folder, exist_ok=True)
            im.save(os.path.join(folder, name), quality=86, optimize=True, progressive=True)
            wanted.add(os.path.join(folder, name))
        manifest.setdefault(lid, {})[kind] = f'covers-own/{lid}-{kind}.jpg'
        print('wrote', lid, kind)
    # Composed files whose screenshot is gone are removed (empty drop folder = today's look again).
    for folder in (OUT, WEB_OUT):
        if os.path.isdir(folder):
            for f in os.listdir(folder):
                p = os.path.join(folder, f)
                if f.endswith(('-cover.jpg', '-hero.jpg')) and p not in wanted:
                    os.remove(p)
                    print('removed', p)
    with open(MANIFEST, 'w', encoding='utf-8', newline='\n') as fh:
        fh.write(json.dumps(manifest, indent=2) + '\n')
    print('manifest', MANIFEST, len(manifest), 'games')


if __name__ == '__main__':
    sys.exit(main())
