// Same-origin image proxy of the website (/ext-img/, nginx: apps/web/deploy/ext-img.conf). Visitors' browsers
// never load pictures from third parties; every remote picture the website shows goes through one of these
// fixed path patterns, and nginx fetches it from an allowlisted host. Anything else is not shown at all.
// The launcher and the portal load pictures directly and do not use this.

const SEG = /^[A-Za-z0-9._-]{1,100}$/;
const IMG_EXT = /\.(png|jpe?g|webp|gif)$/i;
const segs = (path: string, min: number, max: number) => {
  const p = path.split('/');
  return p.length >= min && p.length <= max && p.every((s) => SEG.test(s) && s !== '.' && s !== '..') ? p : null;
};

/** The /ext-img/ path of a remote picture, or null when its host or path is not allowlisted. */
export function extImgPath(url: string): string | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password || u.port || u.search || u.hash) return null;
  const path = u.pathname.replace(/^\//, '');
  switch (u.hostname) {
    case 'images.igdb.com': {
      const m = /^igdb\/image\/upload\/t_original\/([a-z0-9]{2,32}\.(?:webp|jpg|png))$/.exec(path);
      return m ? `/ext-img/igdb/${m[1]}` : null;
    }
    case 'shared.akamai.steamstatic.com':
    case 'shared.steamstatic.com':
    case 'cdn.cloudflare.steamstatic.com': {
      const m = /(?:^|\/)apps\/(\d{1,10})\/(library_600x900\.jpg|library_hero\.jpg|header\.jpg|logo\.png)$/.exec(path);
      return m ? `/ext-img/steam/${m[1]}/${m[2]}` : null;
    }
    case 'raw.githubusercontent.com': {
      // <owner>/<repo>/<ref>/<path to a picture>
      const p = segs(path, 4, 12);
      return p && IMG_EXT.test(path) ? `/ext-img/gh-raw/${p.join('/')}` : null;
    }
    case 'github.com': {
      // release assets: <owner>/<repo>/releases/download/<tag>/<file>; README attachments: user-attachments/assets/<uuid>
      const p = segs(path, 3, 6);
      if (!p) return null;
      if (p.length === 6 && p[2] === 'releases' && p[3] === 'download' && IMG_EXT.test(p[5]!)) return `/ext-img/gh-rel/${p[0]}/${p[1]}/${p[4]}/${p[5]}`;
      if (p.length === 3 && p[0] === 'user-attachments' && p[1] === 'assets' && /^[0-9a-f-]{36}$/.test(p[2]!)) return `/ext-img/gh-att/${p[2]}`;
      return null;
    }
    case 'i.imgur.com': {
      const m = /^([A-Za-z0-9]{5,12}\.(?:png|jpe?g|webp|gif))$/.exec(path);
      return m ? `/ext-img/imgur/${m[1]}` : null;
    }
    default:
      return null;
  }
}

/** A picture source for the website: same-origin paths as they are, remote ones through /ext-img/, else null (not shown). */
export function webImg(src: string | null | undefined): string | null {
  if (!src) return null;
  if (src.startsWith('/') && !src.startsWith('//')) return src;
  return extImgPath(src);
}
