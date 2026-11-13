"""Windows icons, installer pictures and Tauri PNGs from the D6a "TM" logo (Saturn over the horizon with the TM lettering).

    python tools/make-icons-d6a.py "<TM Horizon Logos>/horizon-d6a-tm2.png" "<TM Horizon Logos>/horizon-d6a.png"

64 px and up are the TM logo scaled down. 16-32 px are hand-tuned so "TM" stays readable: the plain planet
(horizon-d6a.png, no lettering) with a bolder "TM" drawn on top (white to grey, dark outline), as on
d6a-tm-sheet.png. Writes into src-tauri/icons: icon.ico (16, 20, 24, 32, 40, 48, 64, 96, 128, 256), icon.png,
32x32.png, 64x64.png, 128x128.png, 128x128@2x.png and the Square*Logo/StoreLogo PNGs, and copies the sources as source-horizon-d6a(-tm2).png. The app UI keeps the plain planet
next to its own wordmark (public/app-icon.png, favicon-32.png are not touched), and so do the installer's
header (planet beside the TM HORIZON wordmark) and sidebar (already the TM logo): nsis-*.bmp are not touched.
"""
import os
import shutil
import sys

from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
ICONS = os.path.join(HERE, "..", "src-tauri", "icons")
ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256]
SMALL = 32  # up to this size the TM is redrawn
FONTS = [r"C:\Windows\Fonts\ariblk.ttf", r"C:\Windows\Fonts\seguibl.ttf", r"C:\Windows\Fonts\arialbd.ttf"]


def font(px):
    for f in FONTS:
        if os.path.exists(f):
            return ImageFont.truetype(f, px)
    return ImageFont.load_default()


def bold_tm(plain, size):
    """The plain planet at `size` with a large, bold TM (drawn 8x and scaled down)."""
    k = 8
    s = size * k
    base = plain.resize((s, s), Image.LANCZOS)
    # lettering: about 64 % of the width, centred a little below the middle (where the TM logo has it)
    f = font(int(s * 0.40))
    text = "TM"
    l, t, r, b = f.getbbox(text)
    w, h = r - l, b - t
    scale = (s * 0.64) / w
    if scale < 1:
        f = font(int(s * 0.40 * scale))
        l, t, r, b = f.getbbox(text)
        w, h = r - l, b - t
    x = (s - w) / 2 - l
    y = s * 0.71 - h / 2 - t
    # dark outline for contrast against the ring and the horizon glow
    outline = Image.new("L", (s, s), 0)
    ImageDraw.Draw(outline).text((x, y), text, font=f, fill=255, stroke_width=max(2, int(s * 0.022)), stroke_fill=255)
    outline = outline.filter(ImageFilter.GaussianBlur(s * 0.006))
    dark = Image.new("RGBA", (s, s), (6, 10, 24, 255))
    base.paste(dark, (0, 0), outline.point(lambda v: int(v * 0.9)))
    # letters: white at the top to light grey at the bottom (the chrome of the big logo, simplified)
    mask = Image.new("L", (s, s), 0)
    ImageDraw.Draw(mask).text((x, y), text, font=f, fill=255)
    grad = Image.new("RGBA", (s, s))
    top, bottom = int(y + t), int(y + b)
    gd = ImageDraw.Draw(grad)
    for yy in range(s):
        u = min(1.0, max(0.0, (yy - top) / max(1, bottom - top)))
        c = int(255 - 70 * u)
        gd.line([(0, yy), (s, yy)], fill=(c, c, min(255, c + 8), 255))
    base.paste(grad, (0, 0), mask)
    # keep the rounded corners of the original
    base.putalpha(Image.composite(base.getchannel("A"), Image.new("L", (s, s), 0), plain.resize((s, s), Image.LANCZOS).getchannel("A")))
    return base.resize((size, size), Image.LANCZOS)


def icon_at(tm, plain, size):
    if size <= SMALL:
        return bold_tm(plain, size)
    im = tm.resize((size, size), Image.LANCZOS)
    return im.filter(ImageFilter.UnsharpMask(radius=0.6, percent=60, threshold=2)) if size <= 64 else im


def main(tm_path, plain_path):
    tm = Image.open(tm_path).convert("RGBA")
    plain = Image.open(plain_path).convert("RGBA")
    frames = {s: icon_at(tm, plain, s) for s in ICO_SIZES}
    big = tm.resize((256, 256), Image.LANCZOS)
    big.save(os.path.join(ICONS, "icon.ico"), sizes=[(s, s) for s in ICO_SIZES], append_images=[frames[s] for s in ICO_SIZES if s != 256])
    tm.save(os.path.join(ICONS, "icon.png"))
    for name, s in [("32x32.png", 32), ("64x64.png", 64), ("128x128.png", 128), ("128x128@2x.png", 256)]:
        frames.get(s, icon_at(tm, plain, s)).save(os.path.join(ICONS, name))
    for name, s in [("Square30x30Logo.png", 30), ("Square44x44Logo.png", 44), ("Square71x71Logo.png", 71), ("Square89x89Logo.png", 89),
                    ("Square107x107Logo.png", 107), ("Square142x142Logo.png", 142), ("Square150x150Logo.png", 150),
                    ("Square284x284Logo.png", 284), ("Square310x310Logo.png", 310), ("StoreLogo.png", 50)]:
        icon_at(tm, plain, s).save(os.path.join(ICONS, name))
    shutil.copyfile(tm_path, os.path.join(ICONS, "source-horizon-d6a-tm2.png"))
    shutil.copyfile(plain_path, os.path.join(ICONS, "source-horizon-d6a.png"))
    print("icons written:", ", ".join(str(s) for s in ICO_SIZES))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
