// The News page's source: GitHub releases of the hub projects (always) plus the Exchange sites' own
// posts (native app only; the Rust side caches them for an hour). Shared by Home and News.
import { useEffect, useState } from 'react';
import { backend, type ExchangePost } from './backend';
import { exchangeNewsItems, latestNews, mergeNews, modIconOfProject, projectsFile, type NewsItem } from './hub';
import { repoHero } from '../pages/Gallery';

let posts: ExchangePost[] | null = null;
let inflight: Promise<ExchangePost[]> | null = null;
/** Sites with no older posts ("Load older" skips them); listeners re-render the News page. */
const doneHosts = new Set<string>();
const listeners = new Set<(p: ExchangePost[]) => void>();
let older: Promise<void> | null = null;

/** "Load older": the next page of every Exchange site, merged without duplicates (news.rs fetch_older). */
export function loadOlderNews(): Promise<void> {
  if (!backend.exchangeNewsOlder || !posts) return Promise.resolve();
  older ??= backend.exchangeNewsOlder(posts, [...doneHosts]).then((r) => {
    posts = r.posts;
    for (const [h, m] of Object.entries(r.more)) if (!m) doneHosts.add(h);
    listeners.forEach((f) => f(r.posts));
  }).catch(() => undefined).finally(() => { older = null; });
  return older;
}
/** True while some site may still have older posts. */
export const moreNews = () => !!backend.exchangeNewsOlder && !!posts && posts.length > 0 && doneHosts.size < new Set(posts.map((p) => p.host)).size;

/** The Exchange posts (shared cache with the News page). */
export const loadExchangePosts = () => load();

function load(force = false): Promise<ExchangePost[]> {
  if (!backend.exchangeNews) return Promise.resolve([]);
  if (posts && !force) return Promise.resolve(posts);
  inflight ??= backend.exchangeNews(force).then((p) => { posts = p; return p; }).catch(() => posts ?? []).finally(() => { inflight = null; });
  return inflight;
}

const okMemo = new Map<string, Promise<boolean>>();

/** True when the picture loads (through the app's picture cache) and is at least 200 px wide; release texts also
 * link videos, SVG badges and dead URLs, which must not become the cover. */
function usable(u: string): Promise<boolean> {
  let p = okMemo.get(u);
  if (!p) {
    p = (backend.image ? backend.image(u) : Promise.resolve(u))
      .then((src) => new Promise<boolean>((res) => { const i = new Image(); i.onload = () => res(i.naturalWidth >= 200); i.onerror = () => res(false); i.src = src; }))
      .catch(() => false);
    okMemo.set(u, p);
  }
  return p;
}

const coverMemo = new Map<string, Promise<string | null>>();

/** Cover of a release: first picture of the release text, else the repository README's hero picture, else the
 * mod's icon; null when there is none (the card then shows the plain placeholder, never a game cover). */
function releaseCover(n: NewsItem): Promise<string | null> {
  const key = n.projectId ?? n.id;
  let p = coverMemo.get(key);
  if (!p) {
    const proj = projectsFile.projects.find((x) => x.id === n.projectId);
    p = (async () => {
      for (const u of (n.candidates ?? []).slice(0, 4)) if (await usable(u)) return u;
      const hero = proj ? await repoHero(proj.url) : null;
      if (hero) return hero;
      const icon = proj ? modIconOfProject(proj) : null;
      return icon;
    })();
    coverMemo.set(key, p);
  }
  return p;
}

/** Newest news first. `limit` caps the list; `loading` is true until the Exchange posts arrived. */
export function useNews(limit = 40): { items: NewsItem[]; loading: boolean; hasExchange: boolean } {
  const [ex, setEx] = useState<ExchangePost[] | null>(posts);
  const [covers, setCovers] = useState<Record<string, string | null>>({});
  useEffect(() => {
    let live = true;
    load().then((p) => { if (live) setEx(p); });
    listeners.add(setEx);
    return () => { live = false; listeners.delete(setEx); };
  }, []);
  const releases = latestNews(limit);
  const items = mergeNews(releases, exchangeNewsItems(ex ?? [])).slice(0, limit);
  const key = items.filter((n) => n.kind === 'release').map((n) => n.id).join('|');
  useEffect(() => {
    let live = true;
    for (const n of items) {
      if (n.kind !== 'release') continue;
      releaseCover(n).then((u) => { if (live) setCovers((c) => (c[n.id] === u ? c : { ...c, [n.id]: u })); });
    }
    return () => { live = false; };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const withCovers = items.map((n) => (n.kind === 'release' && covers[n.id] ? { ...n, image: covers[n.id] } : n));
  return { items: withCovers, loading: !!backend.exchangeNews && ex === null, hasExchange: !!backend.exchangeNews };
}
