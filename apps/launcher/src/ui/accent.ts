// "Match the game" accent: the hue of the selected game's cover becomes the accent colour. The cover
// is a local file of the app, so the canvas can read it. Nothing leaves the PC.
const VARS = ['--acc', '--acc-2', '--acc-rgb', '--acc-ink', '--acc-soft', '--play-a', '--play-b', '--acc-deep', '--acc-text'];
const cache = new Map<string, number | null>();

export function clearGameAccent() {
  const st = document.documentElement.style;
  VARS.forEach((v) => st.removeProperty(v));
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

/** Weighted mean hue of the cover's colourful pixels, or null when it is mostly grey. */
function hueOf(url: string): Promise<number | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = 48; c.height = 72;
      const g = c.getContext('2d', { willReadFrequently: true });
      if (!g) { resolve(null); return; }
      g.drawImage(img, 0, 0, c.width, c.height);
      const d = g.getImageData(0, 0, c.width, c.height).data;
      let x = 0, y = 0, w = 0;
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i] / 255, gr = d[i + 1] / 255, b = d[i + 2] / 255;
        const max = Math.max(r, gr, b), min = Math.min(r, gr, b), s = max ? (max - min) / max : 0;
        if (s < 0.35 || max < 0.35) continue;
        let h = 0;
        if (max === r) h = ((gr - b) / (max - min)) % 6; else if (max === gr) h = (b - r) / (max - min) + 2; else h = (r - gr) / (max - min) + 4;
        const rad = (h * 60 * Math.PI) / 180, wt = s * max;
        x += Math.cos(rad) * wt; y += Math.sin(rad) * wt; w += wt;
      }
      resolve(w < 40 ? null : ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360);
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

export async function applyGameAccent(cover: string | undefined) {
  if (!cover) { clearGameAccent(); return; }
  if (!cache.has(cover)) cache.set(cover, await hueOf(cover));
  const h = cache.get(cover);
  if (h == null) { clearGameAccent(); return; }
  const hex = (rgb: [number, number, number]) => '#' + rgb.map((v) => v.toString(16).padStart(2, '0')).join('');
  const main = hslToRgb(h, 0.85, 0.6);
  const st = document.documentElement.style;
  st.setProperty('--acc', hex(main));
  st.setProperty('--acc-2', hex(hslToRgb(h, 0.9, 0.76)));
  st.setProperty('--acc-rgb', main.join(', '));
  st.setProperty('--acc-ink', hex(hslToRgb(h, 0.6, 0.08)));
  st.setProperty('--acc-soft', `rgba(${main.join(', ')}, 0.15)`);
  st.setProperty('--play-a', hex(hslToRgb(h, 0.9, 0.74)));
  st.setProperty('--play-b', hex(hslToRgb(h, 0.8, 0.5)));
  st.setProperty('--acc-deep', hex(hslToRgb(h, 0.75, 0.45)));
  st.setProperty('--acc-text', hex(hslToRgb(h, 0.8, 0.32)));
}
