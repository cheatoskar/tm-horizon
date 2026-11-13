import { useEffect, useMemo, useState } from 'react';
import { ExternalLink, History, Loader2, Newspaper, Package, Pin, Search } from 'lucide-react';
import { backend, type ExchangePost } from '../data/backend';
import { newsGameOf, titleOf, upcomingEvents, type NewsItem } from '../data/hub';
import { loadOlderNews, moreNews, useNews } from '../data/news';
import { timeAgo } from '../data/model';
import { go, useHubState } from '../state';
import { GameArt, SectionHead, useCachedImage } from '../ui/common';
import { HubEventRow } from './CommunityServices';
import { fmtDate, useT } from '../i18n';

// Filter chips per game (hub.games ids, names from the games list). Items for no game in particular
// only show under "All". TM².MX (tm.mania.exchange) is one site for all four TrackMania² environments,
// so Canyon, Stadium, Valley and Lagoon share one chip ("tm2"). Turbo is its own game and only gets a
// chip when there is news for it (no feed covers it today).
const FILTER_GAMES = ['tmnf', 'tmuf', 'tmn-eswc', 'tm-original', 'tm-sunrise', 'tm2', 'tm-turbo', 'tm2020'];
const isTm2 = (g: string) => g === 'tm2' || g.startsWith('tm2-');
const hasGame = (n: NewsItem, id: string) => n.games.some((g) => { const x = newsGameOf(g); return id === 'tm2' ? isTm2(x) : x === id; });

/** Date filter: posts of the last n days (0 = all). */
const RANGES = [7, 30, 365, 0] as const;
const RANGE_KEY: Record<number, string> = { 7: 'news.range7', 30: 'news.range30', 365: 'news.range365', 0: 'news.rangeAll' };

const SITE_LABEL: Record<string, string> = { 'tmnf.exchange': 'TMNF-X', 'tmuf.exchange': 'TMUF-X', 'tm.mania.exchange': 'TM²-X', 'trackmania.exchange': 'TMX' };

function useItemGame(n: NewsItem) {
  const hub = useHubState();
  for (const id of n.games) {
    const g = hub.games.find((x) => x.id === id || x.id === titleOf(id));
    if (g) return g;
  }
  return undefined;
}

function Cover({ n, hero }: { n: NewsItem; hero?: boolean }) {
  const src = useCachedImage(n.image);
  const g = useItemGame(n);
  if (n.image && src) return <div className={'nw-cover' + (hero ? ' hero' : '')}><img src={src} alt="" loading={hero ? 'eager' : 'lazy'} decoding="async" /></div>;
  if (g && n.kind === 'exchange') return <GameArt game={g} variant={hero ? 'hero' : 'thumb'} className={'nw-cover' + (hero ? ' hero' : '')} />;
  return <div className={'nw-cover ph' + (hero ? ' hero' : '')}>{n.kind === 'release' ? <Package size={hero ? 48 : 28} strokeWidth={1.3} /> : <Newspaper size={hero ? 48 : 28} strokeWidth={1.3} />}</div>;
}

function Tag({ n }: { n: NewsItem }) {
  const t = useT();
  return (
    <span className="nw-tag">
      {n.kind === 'release' ? t('news.release') : (n.site && SITE_LABEL[n.site.host]) || t('news.exchange')} · {timeAgo(n.date)}
    </span>
  );
}

function Foot({ n }: { n: NewsItem }) {
  const t = useT();
  return (
    <div className="nw-foot dim small">
      {n.author && <span className="ellip">{t('news.by', { name: n.author })}</span>}
      <div className="grow" />
      {n.site && (
        <button className="link-more" onClick={(e) => { e.stopPropagation(); go('maps', `${n.site!.game}@${n.site!.host}`); }} title={t('news.openSiteTip', { site: SITE_LABEL[n.site.host] ?? n.site.host })}>
          {t('news.openSite')}
        </button>
      )}
      <ExternalLink size={13} />
    </div>
  );
}

/** TM Horizon's own announcements, pinned above everything else (GitHub releases marked as news). */
function Pinned() {
  const t = useT();
  const [posts, setPosts] = useState<ExchangePost[]>([]);
  useEffect(() => { backend.horizonNews?.().then((p) => setPosts(p.slice(0, 3)), () => setPosts([])); }, []);
  if (!posts.length) return null;
  return (
    <section className="nw-pinned">
      <SectionHead title={<><Pin size={15} /> {t('news.horizon')}</>} />
      <div className="nw-pinned-list">
        {posts.map((p) => <PinnedPost key={p.id} p={p} />)}
      </div>
    </section>
  );
}

function PinnedPost({ p }: { p: ExchangePost }) {
  const src = useCachedImage(p.image);
  return (
    <button className="nw-pin" onClick={() => backend.openExternal(p.link)}>
      {src ? <img src={src} alt="" /> : <span className="ph"><Newspaper size={24} strokeWidth={1.3} /></span>}
      <span className="min0"><b>{p.title}</b><span className="dim small">{timeAgo(p.date)}</span><p>{p.teaser}</p></span>
    </button>
  );
}

export function News() {
  const t = useT();
  const { items, loading, hasExchange } = useNews(2000);
  const [filter, setFilter] = useState('all');
  const [tab, setTab] = useState<'game' | 'mods'>('game');
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<'new' | 'old'>('new');
  const [range, setRange] = useState<number>(0);
  const [olderBusy, setOlderBusy] = useState(false);
  const tabItems = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const since = range ? Date.now() - range * 86_400_000 : 0;
    const l = items.filter((n) => (tab === 'mods') === (n.kind === 'release')
      && (!since || Date.parse(n.date) >= since)
      && (!needle || [n.title, n.text, n.author ?? ''].join(' ').toLowerCase().includes(needle)));
    return sort === 'old' ? [...l].reverse() : l;
  }, [items, tab, q, range, sort]);
  // Oldest Exchange post loaded: "Shows posts back to <date>".
  const oldestEx = useMemo(() => items.filter((n) => n.kind === 'exchange').reduce<string | null>((m, n) => (!m || n.date < m ? n.date : m), null), [items]);
  const older = async () => { setOlderBusy(true); await loadOlderNews(); setOlderBusy(false); };
  const live = upcomingEvents().filter((e) => Date.parse(e.start) <= Date.now());

  const hub = useHubState();
  const allFilters = useMemo(() => FILTER_GAMES.flatMap((id) => {
    if (id === 'tm2') return [{ id, label: t('news.tm2'), tip: t('news.tm2Tip') }];
    const g = hub.games.find((x) => x.id === id);
    return g ? [{ id, label: g.short, tip: g.name }] : [];
  }), [hub.games, t]);
  const counts = useMemo(() => Object.fromEntries(allFilters.map((f) => [f.id, tabItems.filter((n) => hasGame(n, f.id)).length])), [tabItems, allFilters]);
  // Only games that have posts in this tab (the chosen one always stays, so it can be switched off).
  const filters = allFilters.filter((f) => counts[f.id] > 0 || filter === f.id);
  const shown = useMemo(() => (filter === 'all' ? tabItems : tabItems.filter((n) => hasGame(n, filter))), [tabItems, filter]);

  // Lead story: the newest item with its own picture, else simply the newest.
  const lead = shown.find((n) => n.image) ?? shown[0];
  const rest = shown.filter((n) => n !== lead);
  const open = (n: NewsItem) => backend.openExternal(n.url);

  return (
    <div className="page wide nw">
      <div className="page-head">
        <div>
          <h1>{t('nav.news')}</h1>
          <span className="dim">{hasExchange ? t('news.sub') : t('news.subPreview')}</span>
        </div>
      </div>

      {live.length > 0 && (
        <section className="nw-live">
          <SectionHead title={t('news.live')} />
          <div className="nw-live-list">{live.map((e) => <HubEventRow key={e.id} e={e} />)}</div>
        </section>
      )}

      <Pinned />

      <div className="chips nw-tabs">
        {(['game', 'mods'] as const).map((k) => (
          <button key={k} className={'fchip' + (tab === k ? ' on' : '')} onClick={() => { setTab(k); setFilter('all'); }}>
            {t(k === 'game' ? 'news.tabGame' : 'news.tabMods')} <span className="dim">{items.filter((n) => (k === 'mods') === (n.kind === 'release')).length}</span>
          </button>
        ))}
      </div>

      <div className="toolbar nw-toolbar">
        <label className="search grow">
          <Search size={16} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('news.search')} aria-label={t('news.search')} />
        </label>
        <div className="seg small-seg" role="radiogroup" aria-label={t('news.range')}>
          {RANGES.map((r) => <button key={r} role="radio" aria-checked={range === r} className={range === r ? 'on' : ''} onClick={() => setRange(r)}>{t(RANGE_KEY[r])}</button>)}
        </div>
        <label className="select">
          <span className="dim small">{t('mods.sort')}</span>
          <select value={sort} onChange={(e) => setSort(e.target.value as 'new' | 'old')}>
            <option value="new">{t('news.sortNew')}</option>
            <option value="old">{t('news.sortOld')}</option>
          </select>
        </label>
      </div>

      <div className="chips nw-filters">
        <button className={'fchip' + (filter === 'all' ? ' on' : '')} onClick={() => setFilter('all')}>{t('common.all')}</button>
        {filters.map((f) => (
          <button key={f.id} className={'fchip' + (filter === f.id ? ' on' : '') + (counts[f.id] === 0 ? ' zero' : '')} title={f.tip} onClick={() => setFilter(f.id)}>
            {f.label} <span className="dim">{counts[f.id]}</span>
          </button>
        ))}
      </div>

      {lead && (
        <button className="nw-lead" onClick={() => open(lead)} title={lead.url}>
          <Cover n={lead} hero />
          <div className="nw-lead-shade" />
          <div className="nw-lead-body">
            <Tag n={lead} />
            <h2 className="clamp2" title={lead.title}>{lead.title}</h2>
            {lead.text && <p className="clamp3">{lead.text}</p>}
            <Foot n={lead} />
          </div>
        </button>
      )}

      {rest.length > 0 && (
        <div className="nw-grid">
          {rest.map((n) => (
            <div className="nw-card" key={n.id} role="link" tabIndex={0} onClick={() => open(n)} onKeyDown={(e) => { if (e.key === 'Enter') open(n); }} title={n.url}>
              <Cover n={n} />
              <div className="nw-card-body">
                <Tag n={n} />
                <b className="clamp2" title={n.title}>{n.title}</b>
                {n.text && <span className="dim small clamp3">{n.text}</span>}
                <Foot n={n} />
              </div>
            </div>
          ))}
        </div>
      )}

      {!lead && !loading && (
        <div className="empty-state">
          <Newspaper size={42} strokeWidth={1.4} />
          <b>{q.trim() || range ? t('news.noMatch') : filter === 'all' ? t('news.none') : t('news.noneGame')}</b>
        </div>
      )}
      {hasExchange && tab === 'game' && oldestEx && (
        <div className="nw-older">
          <span className="dim small">{t('news.until', { date: fmtDate(oldestEx) })}</span>
          {moreNews()
            ? <button className="btn ghost sm" disabled={olderBusy} title={t('news.olderTip')} onClick={() => void older()}>{olderBusy ? <Loader2 size={14} className="spin" /> : <History size={14} />} {t('news.older')}</button>
            : <span className="dim small">{t('news.allLoaded')}</span>}
        </div>
      )}
      {loading && <div className="dim small nw-loading">{t('news.loading')}</div>}
    </div>
  );
}
