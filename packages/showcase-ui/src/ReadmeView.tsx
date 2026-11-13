// A rendered README for React hosts (launcher, portal). The website renders the same HTML statically
// with renderReadme() from './readme.ts'. Import the styles once: `import '@tm-hub/showcase-ui/readme.css'`.
import { useEffect, useMemo, useRef } from 'react';
import { renderReadme, type ReadmeOptions } from './readme.ts';

export interface ReadmeViewProps extends ReadmeOptions {
  source: string;
  className?: string;
  /** Loads a picture for the host (launcher: local picture cache); null = drop it. Needs lazySrc. Without it data-src is used as src. */
  loadImage?: (url: string) => Promise<string | null>;
  /** Link click (launcher: system browser). Without it links behave as plain anchors. */
  onLink?: (url: string) => void;
  /** Click on a large picture (launcher: lightbox). */
  onZoom?: (url: string) => void;
}

/** Picture that failed to load or has no content: leaves its link and paragraph too when nothing else is in them. */
function dropImg(img: Element) {
  let el: Element = img;
  for (;;) {
    const up = el.parentElement;
    if (!up || !up.parentElement || up.classList.contains('rd') || !/^(A|P|SPAN|DIV)$/.test(up.tagName)) break;
    if ((up.textContent ?? '').trim() || up.querySelectorAll('img').length > 1) break;
    el = up;
  }
  el.remove();
}

const memo = new Map<string, Promise<string | null>>();

export function ReadmeView({ source, className = '', loadImage, onLink, onZoom, ...opts }: ReadmeViewProps) {
  const lazySrc = !!loadImage || opts.lazySrc;
  const { repo, title, demote, dropBadges, imageUrl, httpsOnly, newTab, maxChars } = opts;
  const html = useMemo(
    () => renderReadme(source, { repo, title, demote, dropBadges, imageUrl, httpsOnly, newTab, maxChars, lazySrc }),
    [source, repo, title, demote, dropBadges, imageUrl, httpsOnly, newTab, maxChars, lazySrc],
  );
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = ref.current;
    if (!root || !lazySrc) return;
    let live = true;
    root.querySelectorAll<HTMLImageElement>('img[data-src]').forEach((img) => {
      const url = img.getAttribute('data-src')!;
      // Photos and screenshots (not icons and badges) get the zoom cursor.
      img.onload = () => { if (img.naturalWidth >= 160 && img.naturalHeight >= 120) img.classList.add('rd-pic'); };
      if (!loadImage) { img.src = url; return; }
      if (!memo.has(url)) memo.set(url, loadImage(url).catch(() => null));
      memo.get(url)!.then((s) => { if (!live) return; if (s) { img.onerror = () => dropImg(img); img.src = s; } else dropImg(img); });
    });
    return () => { live = false; };
  }, [html, lazySrc, loadImage]);
  const onClick = (e: React.MouseEvent) => {
    const t = e.target as HTMLElement;
    if (onZoom && t instanceof HTMLImageElement && t.classList.contains('rd-pic')) {
      e.preventDefault();
      onZoom(t.getAttribute('data-src') ?? t.src);
      return;
    }
    const a = t.closest?.('a');
    if (!a || !onLink) return;
    e.preventDefault();
    const h = a.getAttribute('href') ?? '';
    if (h.startsWith('#')) {
      // In-page anchor: scroll to the heading inside this README.
      const target = ref.current?.querySelector(`[id="${h.slice(1).replace(/["\\]/g, '')}"]`);
      target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else if (/^https?:\/\//i.test(h)) onLink(h);
  };
  // eslint-disable-next-line react/no-danger -- renderReadme only emits allowlisted tags and attributes
  return <div ref={ref} className={`rd ${className}`.trim()} onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />;
}
