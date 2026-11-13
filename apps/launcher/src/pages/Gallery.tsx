import { CATALOG, bodyImages } from '../data/hub';
import { toBody } from '../ui/Modal';
import catalogJson from '@tm-hub/catalog/catalog.json';
import { useCallback, useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { backend } from '../data/backend';
import type { ModView } from '../data/model';
import { useCachedImage } from '../ui/common';
import { useT } from '../i18n';

const MAX = 24;
const memo = new Map<string, Promise<string[]>>();

const isHttps = (u: unknown): u is string => typeof u === 'string' && /^https:\/\//.test(u);
export const isGithub = (u: string | null | undefined) => !!u && /^https:\/\/(www\.)?github\.com\/[^/]+\/[^/?#]+/.test(u);

/** GitHub repository URL of a mod (project, else homepage). */
type Pictures = { mod: string; repo?: string | null; banner?: string; gallery?: string[] };
const PICTURES = (catalogJson as unknown as { pictures?: Pictures[] }).pictures ?? [];
/** Catalog override for a mod whose homepage is another project's repository (e.g. TM Clips -> TMVS repo). */
export const picturesOf = (m: { id?: string; name?: string }): Pictures | undefined =>
  PICTURES.find((p) => [m.id, m.name].some((x) => x && normId(x) === normId(p.mod)));
export const repoUrlOf = (m: Pick<ModView, 'homepage' | 'project'> & { id?: string; name?: string }): string | undefined => {
  const o = picturesOf(m);
  if (o && 'repo' in o) return o.repo && isGithub(o.repo) ? o.repo : undefined;
  return [m.project?.url, m.homepage].find(isGithub) ?? undefined;
};

/** Badges, avatars, logos, donate buttons and the like are no screenshots. */
const NOT_SCREENSHOT = /avatar|icon|logo|badge|shield|favicon|button|ko-?fi|paypal|donat|sponsor|discord|patreon|buymeacoffee/i;
const looksLikeShot = (u: string) => {
  try {
    const x = new URL(u);
    return !/(^|\.)avatars\.githubusercontent\.com$/.test(x.hostname) && !NOT_SCREENSHOT.test(decodeURIComponent(x.pathname));
  } catch { return false; }
};

/** Keeps pictures at least 300 px wide that are not small squares (icons); order stays (docs/images first). */
async function largeOnly(list: string[]): Promise<string[]> {
  if (!backend.image) return list;
  const sizes = await Promise.all(list.map(async (u) => {
    try {
      const src = await backend.image!(u);
      return await new Promise<[number, number]>((res) => { const i = new Image(); i.onload = () => res([i.naturalWidth, i.naturalHeight]); i.onerror = () => res([0, 0]); i.src = src; });
    } catch { return [0, 0] as [number, number]; }
  }));
  return list.filter((_, i) => { const [w, h] = sizes[i]; return w >= 300 && !(Math.abs(w - h) < w * 0.08 && w <= 512); });
}

const normId = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

/** Gallery of a mod, cached per mod in memory. Order: the catalog's `banner` (a hand-picked first picture),
 * the hub/catalog `gallery`, else the GitHub repository's docs/images and README pictures, filtered. */
export function loadGallery(m: Pick<ModView, 'id' | 'gallery' | 'homepage' | 'project'> & { name?: string }): Promise<string[]> {
  let p = memo.get(m.id);
  if (!p) {
    const cat = CATALOG.find((c) => normId(c.name) === normId(m.id) || normId(c.id.replace(/^mod-/, '')) === normId(m.id));
    const ov = picturesOf(m);
    const banner = [ov?.banner ?? cat?.banner].filter((u): u is string => !!u && isHttps(u));
    const own = [...(ov?.gallery ?? []), ...(m.gallery ?? []), ...(cat?.gallery ?? [])].filter(isHttps);
    const repo = repoUrlOf(m);
    const rest: Promise<string[]> = own.length ? Promise.resolve(own)
      : repo && backend.gallery ? backend.gallery(repo).then((l) => largeOnly(l.filter(isHttps).filter(looksLikeShot))).catch(() => []) : Promise.resolve([]);
    p = rest.then((l) => [...new Set([...banner, ...l])].slice(0, MAX));
    memo.set(m.id, p);
  }
  return p;
}

const heroMemo = new Map<string, Promise<string | null>>();

/** The first large picture of a GitHub repository's README (badges, avatars, logos, icons and small squares skipped), or null. */
export function repoHero(repo: string | null | undefined): Promise<string | null> {
  if (!repo || !isGithub(repo) || !backend.readme) return Promise.resolve(null);
  let p = heroMemo.get(repo);
  if (!p) {
    p = backend.readme(repo).then((md) => largeOnly(bodyImages(md).filter(looksLikeShot).slice(0, 8))).then((l) => l[0] ?? null).catch(() => null);
    heroMemo.set(repo, p);
  }
  return p;
}

function useGallery(m: ModView, enabled: boolean): string[] | null {
  const [list, setList] = useState<string[] | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    loadGallery(m).then((l) => { if (live) setList(l); });
    return () => { live = false; };
  }, [m.id, enabled]); // eslint-disable-line react-hooks/exhaustive-deps
  return list;
}

function Pic({ url, className, alt = '' }: { url: string; className?: string; alt?: string }) {
  const src = useCachedImage(url);
  return src ? <img className={className} src={src} alt={alt} decoding="async" draggable={false} /> : <span className={`${className ?? ''} gal-ph`} />;
}

/** Thumbnail strip on the mod detail page, with a lightbox. */
export function ModGallery({ mod }: { mod: ModView }) {
  const t = useT();
  const list = useGallery(mod, true);
  const [open, setOpen] = useState<number | null>(null);
  if (!list || list.length === 0) return null;
  return (
    <section className="panel gal">
      <h3 className="gal-title">{t('gallery.title')} <span className="dim">{list.length}</span></h3>
      <div className="gal-strip">
        {list.map((u, i) => (
          <button key={u} className="gal-thumb" onClick={() => setOpen(i)} title={t('gallery.open')} aria-label={t('gallery.open')}>
            <Pic url={u} />
          </button>
        ))}
      </div>
      {open != null && <Lightbox list={list} index={open} setIndex={setOpen} />}
    </section>
  );
}

export function Lightbox({ list, index, setIndex }: { list: string[]; index: number; setIndex: (i: number | null) => void }) {
  const t = useT();
  const n = list.length;
  const step = useCallback((d: number) => setIndex((index + d + n) % n), [index, n, setIndex]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); setIndex(null); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [step, setIndex]);
  return toBody(
    <div className="gal-lightbox" role="dialog" aria-modal="true" onClick={() => setIndex(null)}>
      <button className="gal-close" onClick={() => setIndex(null)} title={t('gallery.close')} aria-label={t('gallery.close')}><X size={22} /></button>
      {n > 1 && <button className="gal-nav prev" onClick={(e) => { e.stopPropagation(); step(-1); }} title={t('gallery.prev')} aria-label={t('gallery.prev')}><ChevronLeft size={30} /></button>}
      <div className="gal-stage" onClick={(e) => e.stopPropagation()}>
        <Pic url={list[index]} className="gal-big" />
        <div className="gal-count">{index + 1} / {n}</div>
      </div>
      {n > 1 && <button className="gal-nav next" onClick={(e) => { e.stopPropagation(); step(1); }} title={t('gallery.next')} aria-label={t('gallery.next')}><ChevronRight size={30} /></button>}
    </div>,
  );
}

/** One picture in the lightbox (README pictures). */
export function ImageLightbox({ url, onClose }: { url: string; onClose: () => void }) {
  return <Lightbox list={[url]} index={0} setIndex={(i) => { if (i === null) onClose(); }} />;
}
