"""App icon from the prototype's logo: the brand mark (a skewed rounded square with a
conic gradient #ff8a3d -> #ffb15e -> #ff5d2b, see .brand-mark in src/styles.css) on the
app's dark background. Writes src-tauri/app-icon.png (1024 px); `npx tauri icon` makes the rest.
"""
import math
import os
import sys

from PIL import Image, ImageDraw, ImageFilter

N = 1024
SS = 2  # supersampling
W = N * SS

ACC = (0xFF, 0x8A, 0x3D)
ACC2 = (0xFF, 0xB1, 0x5E)
RED = (0xFF, 0x5D, 0x2B)
STOPS = [(0.0, ACC), (1 / 3, ACC2), (2 / 3, RED), (1.0, ACC)]


def lerp(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))


def conic(angle01):
    for (t0, c0), (t1, c1) in zip(STOPS, STOPS[1:]):
        if angle01 <= t1:
            return lerp(c0, c1, (angle01 - t0) / (t1 - t0))
    return STOPS[-1][1]


def main(out):
    # Background tile: dark rounded square like the app window.
    bg = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    d = ImageDraw.Draw(bg)
    d.rounded_rectangle([0, 0, W - 1, W - 1], radius=int(W * 0.22), fill=(16, 19, 26, 255))

    # Conic gradient field (CSS "from 210deg": 0 at 210 degrees, clockwise from the top).
    small = 256
    grad = Image.new("RGB", (small, small))
    px = grad.load()
    for y in range(small):
        for x in range(small):
            a = math.degrees(math.atan2(x - small / 2 + 0.5, -(y - small / 2 + 0.5))) % 360
            px[x, y] = conic(((a - 210) % 360) / 360)
    side = int(W * 0.56)
    grad = grad.resize((side, side), Image.BICUBIC)

    # Mask: rounded square, skewed by -12 degrees like the CSS.
    mask = Image.new("L", (side, side), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, side - 1, side - 1], radius=int(side * 0.28), fill=255)
    k = math.tan(math.radians(12))
    pad = int(side * k)
    big = side + pad
    def skew(img, mode):
        canvas = Image.new(mode, (big, side), 0)
        canvas.paste(img, (pad // 2, 0))
        return canvas.transform((big, side), Image.AFFINE, (1, k, -k * side / 2, 0, 1, 0), Image.BICUBIC)
    mark_rgb = skew(grad, "RGB")
    mark_a = skew(mask, "L")

    # Glow.
    glow = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    ox, oy = (W - big) // 2, (W - side) // 2
    glow_mask = Image.new("L", (W, W), 0)
    glow_mask.paste(mark_a, (ox, oy))
    glow_mask = glow_mask.filter(ImageFilter.GaussianBlur(W * 0.05)).point(lambda v: int(v * 0.6))
    glow.paste((255, 138, 61, 255), (0, 0), glow_mask)
    bg = Image.alpha_composite(bg, glow)

    mark = Image.new("RGBA", (big, side))
    mark.paste(mark_rgb, (0, 0))
    mark.putalpha(mark_a)
    bg.alpha_composite(mark, (ox, oy))

    # Keep the glow inside the tile.
    tile = Image.new("L", (W, W), 0)
    ImageDraw.Draw(tile).rounded_rectangle([0, 0, W - 1, W - 1], radius=int(W * 0.22), fill=255)
    bg.putalpha(Image.composite(bg.getchannel("A"), Image.new("L", (W, W), 0), tile))
    bg.resize((N, N), Image.LANCZOS).save(out)
    print("written", out)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "..", "src-tauri", "app-icon.png"))
