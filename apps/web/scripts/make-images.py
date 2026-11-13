"""One-off: crop/compress the TM Vibrant Shaders screenshots (mod gallery) into public/img. Game art: fetch-game-art.py. Run: python scripts/make-images.py"""
import os
from PIL import Image

TM = r'%USERPROFILE%/Documents/TrackMania/TMVS/'
MP = r'%USERPROFILE%/Documents/ManiaPlanet/TMVS/'
DOC = r'%USERPROFILE%/Downloads/tm shaders/TM-Vibrant-Shaders/docs/images/'
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'public', 'img')
os.makedirs(OUT, exist_ok=True)

# name, source, target width, aspect (w/h) or None to keep
JOBS = [
    ('mod-tmvs-night', DOC + 'compare-night.jpg', 1280, 16 / 9),
    ('mod-tmvs-aurora', DOC + 'aurora.jpg', 1280, 16 / 9),
    ('mod-tmvs-blackhole', DOC + 'black-hole.jpg', 1280, 16 / 9),
    ('mod-tmvs-menu', DOC + 'menu.jpg', 1280, 16 / 9),
    ('mod-tmvs-sunset', DOC + 'compare-sunset.jpg', 1280, 16 / 9),
]

for name, src, w, ar in JOBS:
    if not os.path.exists(src):
        print('missing', src)
        continue
    im = Image.open(src).convert('RGB')
    iw, ih = im.size
    if ar:
        th = int(iw / ar)
        if th <= ih:
            top = (ih - th) // 2
            im = im.crop((0, top, iw, top + th))
        else:
            nw = int(ih * ar)
            left = (iw - nw) // 2
            im = im.crop((left, 0, left + nw, ih))
    h = int(w * im.size[1] / im.size[0])
    im = im.resize((w, h), Image.LANCZOS)
    im.save(os.path.join(OUT, name + '.webp'), quality=78, method=6)
    print(name, im.size, os.path.getsize(os.path.join(OUT, name + '.webp')) // 1024, 'KB')
