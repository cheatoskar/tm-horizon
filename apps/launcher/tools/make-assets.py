# Crop/resize my own screenshots into public/art for news, events, skins and the
# in-game overlay mock (local prototype only). Game covers come from Steam, see
# scanner/fetch-art.mjs.
# Usage: python -I tools/make-assets.py
import os
from PIL import Image

HOME = os.path.expanduser('~')
TM = os.path.join(HOME, 'Documents', 'TrackMania', 'TMVS')
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'public', 'art')
os.makedirs(OUT, exist_ok=True)

# name: (source, pre-crop box or None, focal x, focal y)
SRC = {
    'overlay-bg':  (os.path.join(TM, 'screen_154.bmp'), None, 0.5, 0.5),
    'news-1':      (os.path.join(TM, 'photo_031.png'), None, 0.5, 0.5),
    'news-2':      (os.path.join(TM, 'photo_022.png'), None, 0.5, 0.5),
    'news-3':      (os.path.join(TM, 'photo_032.png'), None, 0.5, 0.5),
    'news-4':      (os.path.join(TM, 'photo_014.png'), None, 0.5, 0.4),
    'skin-1':      (os.path.join(TM, 'photo_013.png'), (900, 300, 1700, 1000), 0.5, 0.5),
    'skin-2':      (os.path.join(TM, 'screen_133.bmp'), (700, 500, 1900, 1300), 0.5, 0.5),
    'skin-3':      (os.path.join(TM, 'screen_150.bmp'), (700, 450, 1900, 1250), 0.5, 0.5),
    'skin-4':      (os.path.join(TM, 'photo_042.png'), (640, 400, 1280, 960), 0.5, 0.5),
    'pack-1':      (os.path.join(TM, 'photo_027.png'), None, 0.5, 0.5),
    'pack-2':      (os.path.join(TM, 'photo_025.png'), None, 0.5, 0.5),
    'pack-3':      (os.path.join(TM, 'photo_012.png'), None, 0.5, 0.5),
    'pack-4':      (os.path.join(TM, 'photo_029.png'), (1600, 0, 2560, 1440), 0.5, 0.5),
}


def cover(im, w, h, fx, fy):
    sw, sh = im.size
    scale = max(w / sw, h / sh)
    nw, nh = round(sw * scale), round(sh * scale)
    im = im.resize((nw, nh), Image.LANCZOS)
    x = min(max(round(nw * fx - w / 2), 0), nw - w)
    y = min(max(round(nh * fy - h / 2), 0), nh - h)
    return im.crop((x, y, x + w, y + h))


# Trim the transparent padding around the Steam logos (run after scanner/fetch-art.mjs).
STORE = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'public', 'store-art')
for t in sorted(os.listdir(STORE)) if os.path.isdir(STORE) else []:
    lp = os.path.join(STORE, t, 'logo.png')
    if os.path.exists(lp):
        lg = Image.open(lp).convert('RGBA')
        bb = lg.getchannel('A').point(lambda a: 255 if a > 8 else 0).getbbox()
        if bb and bb != (0, 0) + lg.size:
            lg.crop(bb).save(lp)
            print('trimmed logo', t, lg.size, '->', (bb[2] - bb[0], bb[3] - bb[1]))

for name, (src, box, fx, fy) in SRC.items():
    im = Image.open(src).convert('RGB')
    if box:
        im = im.crop(box)
    hero = im.copy()
    hero.thumbnail((1920, 1920), Image.LANCZOS)
    hero.save(os.path.join(OUT, name + '.jpg'), quality=84, optimize=True, progressive=True)
    cover(im, 640, 400, fx, fy).save(os.path.join(OUT, name + '-card.jpg'), quality=82, optimize=True, progressive=True)
    print(name, im.size)
