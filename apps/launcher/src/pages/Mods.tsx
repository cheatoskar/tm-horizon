import { goBack, canGoBack } from '../data/navHistory';
import { useEffect, useMemo, useState } from 'react';
import {
  type LucideIcon, RotateCcw, ArrowLeft, ArrowUpCircle, Bot, Boxes, Check, Download, ExternalLink, Film, Gamepad2, Gauge, Glasses, Globe, HardDrive,
  Layers, LayoutGrid, List, Loader2, Package, PencilRuler, RefreshCw, Search, ShieldCheck, Sparkles, Star, Trophy, User, Users, Wrench, Github, Scale, Code2,
} from 'lucide-react';
import { CATALOG, COLLECTIONS, fmtNum, linkIntent, modsIntent, projectsFile, releaseDownloads } from '../data/hub';
import { fuzzyScore } from '../data/fuzzy';
import { ModUpdates } from '../ui/ModUpdates';
import { go, tmlName, useHubState } from '../state';
import { GameChip, ModIcon, SectionHead } from '../ui/common';
import { allVersions, changelogFor, fmtSize, timeAgo, type ModView } from '../data/model';
import { ModTile, foreverMods } from './GamePage';
import { CatalogCard, catalogInstallable, opAllInstalled, catalogModById, catalogSrc, COMMUNITY_SRC, OpCard, SrcBadge, fitsGame, opGameIds, useCatalogMods, useCommunityCount, useOpPlugins, type CatalogMod, type ModSource } from './ModSources';
import { CatalogBackups, CatalogInstallDialog } from '../ui/CatalogInstall';
import { CatalogModPage, OpPluginPage } from './CatalogModPage';
import type { InstallRecord } from '../data/backend';
import type { OpPlugin } from '../data/backend';
import { backend, isNative } from '../data/backend';
import { ModGallery } from './Gallery';
import { RelatedSection } from '../ui/Related';
import { ModShowcase, clickInstall } from '../ui/ModShowcase';
import { showcaseFor } from '../data/showcase';
import { TmvsContent } from '../ui/TmvsContent';

const TMVS_ID = 'TM Vibrant Shaders';
import { companionOf, relatedLinksOf } from '../data/links';
import { HeroBg, ReadmeView, ReleaseNotes, ReleasesList, releaseFor, repoUrlOf, useReleases } from './ModDoc';
import { tn, tp, trOr, useT } from '../i18n';
import { HorizonPluginsBrowser } from '../ui/HorizonHost';

const CAT_ICON: Record<string, LucideIcon> = {
  Graphics: Sparkles, Video: Film, TAS: Bot, Tools: Wrench, Editor: PencilRuler, Competitive: Trophy, Fixes: ShieldCheck,
  HUD: Gauge, Community: Users, VR: Glasses, Library: Boxes, Game: Gamepad2,
};

function Cat({ c }: { c: string }) {
  const I = CAT_ICON[c] ?? Wrench;
  return <span className="cat"><I size={12} />{trOr('cat.' + c, c)}</span>;
}

const GAMES = [
  { id: 'tmnf', label: 'Nations Forever' },
  { id: 'tmuf', label: 'United Forever' },
  { id: 'maniaplanet', label: 'TM² / ManiaPlanet' },
  { id: 'tm2020', label: 'Trackmania' },
  { id: 'tmn-eswc', label: 'Nations ESWC' },
  { id: 'tm-sunrise', label: 'Sunrise' },
  { id: 'tm-original', label: 'Original' },
];

function ActionButton({ m, big }: { m: ModView; big?: boolean }) {
  const hub = useHubState();
  const t = useT();
  const profile = hub.profileFor('tmuf');
  const pname = tmlName(profile);
  const inProfile = !!profile?.mods.some((x) => x.id === m.id);
  const cls = big ? '' : ' sm';
  const busy = hub.busy['mod:' + m.id];
  const enableable = m.type === 'modification' && m.id !== 'CoreMod';
  const install = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!profile) return;
    const version = m.latest ?? m.installedLatest ?? '';
    // New installs ask where: which profiles to switch it on in (updates go straight through).
    if (isNative && enableable && !m.installedVersions.length) { hub.setDialog({ kind: 'install', modId: m.id }); return; }
    if (isNative) {
      hub.setBusy((b) => ({ ...b, ['mod:' + m.id]: 'download' }));
      const r = await backend.installMod(m.id, version, pname ?? '', enableable && !inProfile && !!pname);
      hub.setBusy((b) => { const n = { ...b }; delete n['mod:' + m.id]; return n; });
      hub.toast(r);
      return;
    }
    hub.toast(await backend.installMod(m.id, version, profile.name));
    if (!inProfile && enableable) hub.toggleMod(profile.id, m.id);
  };
  const add = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isNative) { hub.setDialog({ kind: 'install', modId: m.id }); return; }
    if (profile) hub.toggleMod(profile.id, m.id);
  };
  if (busy) return <span className={'btn ghost disabled' + cls}><Loader2 size={15} className="spin" /> {t('mods.installing')}</span>;
  if (m.type === 'program') return <span className="pill">{t('mods.program')}</span>;
  if (m.updateAvailable && m.remote?.versions[0]?.download) return <button className={'btn primary' + cls} onClick={install} title={pname ? t('mods.updateTipFor', { v: m.latest, profile: pname }) : t('mods.updateTip', { v: m.latest })}><ArrowUpCircle size={15} /> {t('common.update')}</button>;
  if (m.id === 'CoreMod' && m.installedVersions.length) return <span className="pill ok"><Check size={13} /> {t('common.installed')}</span>;
  if (m.installedVersions.length && inProfile) return <span className="pill ok"><Check size={13} /> {t('mods.inProfile')}</span>;
  if (m.installedVersions.length) return enableable && pname
    ? <button className={'btn ghost' + cls} onClick={add} title={t('mods.addTip', { profile: pname })}>{t('mods.add')}</button>
    : <span className="pill ok"><Check size={13} /> {t('common.installed')}</span>;
  if (!m.latest || !m.remote?.versions[0]?.download) return <span className="pill">{t('mods.localOnly')}</span>;
  return <button className={'btn primary' + cls} onClick={install} title={pname ? t('mods.installTip', { profile: pname }) : t('mods.installTipNone')}><Download size={15} /> {t('common.install')}</button>;
}

function Facet({ title, items, sel, toggle }: { title: string; items: { id: string; label: string; n: number; icon?: LucideIcon }[]; sel: Set<string>; toggle: (id: string) => void }) {
  return (
    <div className="facet">
      <h4>{title}</h4>
      {items.map((it) => (
        <label key={it.id} className={'facet-row' + (it.n === 0 ? ' zero' : '')}>
          <input type="checkbox" checked={sel.has(it.id)} onChange={() => toggle(it.id)} />
          <span className="box">{sel.has(it.id) && <Check size={11} strokeWidth={3} />}</span>
          {it.icon && <it.icon size={14} />}
          <span className="grow">{it.label}</span>
          <span className="dim small">{it.n}</span>
        </label>
      ))}
    </div>
  );
}

/** The Mods list's view (tab, search, sort, filters) for this session: coming back to Mods (from another
 * section or a mod page) shows it as it was. Clicking Mods while on Mods starts fresh (resetModsView). */
const modsView: Record<string, unknown> = {};
export const resetModsView = () => { for (const k of Object.keys(modsView)) delete modsView[k]; };
function useKept<T>(key: string, init: T) {
  const [v, set] = useState<T>(() => (key in modsView ? (modsView[key] as T) : init));
  useEffect(() => { modsView[key] = v; }, [key, v]);
  return [v, set] as const;
}

const useSet = (init: string[] = [], key?: string) => {
  const [s, set] = useState<Set<string>>(() => new Set(key && key in modsView ? (modsView[key] as string[]) : init));
  useEffect(() => { if (key) modsView[key] = [...s]; }, [key, s]);
  return [s, (id: string) => set((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; }), () => set(new Set())] as const;
};

/** Source facet values of the catalog entries that are not on a TMLoader server, and of Openplanet. */
const CATALOG_SRC = 'catalog-other';
const OPENPLANET_SRC = 'openplanet';
const TAS_SRC = 'tas-plugin';
/** Catalog modType -> the launcher's category facet. */
const MODTYPE_CAT: Record<string, string> = {
  graphics: 'Graphics', texturepack: 'Graphics', blockskin: 'Graphics', skin: 'Graphics', hud: 'HUD', interface: 'HUD', fix: 'Fixes',
  utility: 'Tools', block: 'Library', sound: 'Game', music: 'Game', vehicle: 'Game', standalone: 'Game', medals: 'Game',
  // Types from the catalog reclassification (packages/catalog/types.json).
  tas: 'TAS', editor: 'Editor', server: 'Tools', library: 'Library', plugin: 'Tools', platform: 'Library', environment: 'Game', gameplay: 'Game',
};
/** One row of the unified list: a TMLoader mod, a catalog entry or an Openplanet plugin. */
type Row = {
  key: string; src: ModSource; srcId: string; name: string; text: string; games: string[]; cats: string[];
  status: 'update' | 'installed' | 'available'; updated: string; downloads: number;
  /** First release / first seen (ISO date or ''), popularity (stars x 10 + downloads), normalised ids for collections. */
  first: string; pop: number; ids: string[];
  tml?: ModView; cat?: CatalogMod; op?: OpPlugin;
};
const PAGE = 60;
const normId = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, '');
type SortKey = 'installable' | 'relevance' | 'updated' | 'new' | 'popular' | 'name';
/** "Installable first": TAS entries (TAS mode) and the Openplanet loader on top, then what TM Horizon
 * installs itself (TMLoader mods with a download or already installed), then catalog mods it installs
 * (file installs, ESWC proxy DLLs) and Openplanet plugins, last the "open page only" entries. */
const rankOf = (r: Row, opInstalled = false) => {
  // Openplanet already installed (every game of it on this PC has Openplanet.dll): no longer on top.
  if (r.cat?.id === 'openplanet') return opInstalled ? 2 : 0;
  if (r.src === 'tas') return 0;
  if (r.tml) return r.tml.remote?.versions[0]?.download || r.tml.installedVersions.length ? 1 : 3;
  if (r.op) return 2;
  if (r.cat) return catalogInstallable(r.cat) ? 2 : 3;
  return 3;
};
const projectOf = (id: string) => projectsFile.projects.find((p) => p.catalogIds.includes(id)) ?? null;

export function Mods() {
  const hub = useHubState();
  const t = useT();
  // A game handed over by a game page ("All mods for ...") starts a fresh view with that filter.
  const intent = useState(() => { const g = modsIntent.game; modsIntent.game = null; if (g) resetModsView(); return g ? [g.startsWith('tm2-') || g === 'sm-storm' ? 'maniaplanet' : g] : []; })[0];
  const [tab, setTab] = useKept<'browse' | 'installed' | 'tools'>('tab', 'browse');
  const [q, setQ] = useKept('q', '');
  const [sort, setSort] = useKept<SortKey>('sort', 'installable');
  const [cats, toggleCat, clearCats] = useSet([], 'cats');
  // Opened from a game page ("All mods for ..."): that game's filter is set once.
  const [games, toggleGame, clearGames] = useSet(intent, 'games');
  const [srcs, toggleSrc, clearSrcs] = useSet([], 'srcs');
  const [status, toggleStatus, clearStatus] = useSet([], 'status');
  const mods = hub.mods.filter((m) => m.type !== 'program');
  const catalogMods = useCatalogMods();
  const communityN = useCommunityCount();
  const ops = useOpPlugins(tab === 'browse');
  const opCount = ops?.length ?? 0;
  const [shownN, setShownN] = useKept('shown', PAGE);
  const [coll, setColl] = useKept<string | null>('coll', null);
  // Browse view: everything, only the TMLoader list, only community-listed entries, or Openplanet plugins.
  const [view, setView] = useKept<'all' | 'tmloader' | 'community' | 'openplanet' | 'horizon'>('view', 'all');

  const statusOf = (m: ModView) => m.updateAvailable ? 'update' : m.installedVersions.length ? 'installed' : 'available';
  const rows = useMemo<Row[]>(() => [
    ...mods.map((m): Row => ({ key: 'm:' + m.id, src: 'tmloader', srcId: m.source, name: m.name, text: [m.author, m.description].join(' '), games: m.games, cats: m.categories,
      status: statusOf(m), updated: m.updated ?? '', downloads: m.downloads ?? -1,
      first: [...(m.remote?.versions ?? []).map((v) => v.updated ?? ''), ...(m.local?.versions ?? []).map(() => '')].filter(Boolean).sort()[0] ?? '',
      pop: (m.downloads ?? 0) + (m.stars ?? 0) * 10, ids: [normId(m.id), normId(m.name)], tml: m })),
    ...catalogMods.map((c): Row => { const pr = projectOf(c.id); return ({ key: 'c:' + c.id, src: catalogSrc(c),
      srcId: c.category === 'tas-plugin' ? TAS_SRC : c.community ? COMMUNITY_SRC : CATALOG_SRC, name: c.name,
      text: [c.author, c.maintainer, c.description, c.modType].join(' '), games: c.games, cats: c.category === 'tas-plugin' ? ['TAS'] : c.modType && MODTYPE_CAT[c.modType] ? [MODTYPE_CAT[c.modType]] : [],
      status: 'available', updated: pr?.release?.published ?? pr?.pushed ?? '', downloads: releaseDownloads(pr) ?? -1,
      first: pr?.release?.published ?? '', pop: (releaseDownloads(pr) ?? 0) + (pr?.stars ?? 0) * 10, ids: [normId(c.id), normId(c.name)], cat: c }); }),
    ...(ops ?? []).map((p): Row => ({ key: 'o:' + p.id, src: 'openplanet', srcId: OPENPLANET_SRC, name: p.name, text: [...p.authors, p.short].join(' '), games: opGameIds(p), cats: [],
      status: 'available', updated: p.updated ? new Date(p.updated * 1000).toISOString() : '', downloads: p.downloads, first: '', pop: p.downloads, ids: [normId(p.identifier)], op: p })),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ].sort((a, b) => Number(b.src === 'tas') - Number(a.src === 'tas')), [mods, catalogMods, ops]);
  const inView = (r: Row) => view === 'all' || (view === 'tmloader' ? r.src === 'tmloader' : view === 'community' ? r.src === 'community' : r.src === 'openplanet');
  const collection = COLLECTIONS.find((c) => c.id === coll) ?? null;
  const collIds = useMemo(() => new Set((collection?.entries ?? []).map(normId)), [collection]);
  const list = useMemo(() => {
    const scores = new Map<string, number>();
    const r = rows.filter((x) => {
      if (!inView(x) || (cats.size && !x.cats.some((c) => cats.has(c))) || !fitsGame(x.games, games) || (srcs.size && !srcs.has(x.srcId)) || (status.size && !status.has(x.status))) return false;
      if (collection && !x.ids.some((i) => collIds.has(i))) return false;
      if (!q.trim()) return true;
      // "author:name" (or "von:name"): only mods whose author or maintainer contains the name, no fuzzy matches.
      const am = /^\s*(?:author|von|autor|auteur):\s*(.+?)\s*$/i.exec(q);
      if (am) {
        const who = [x.cat?.author, x.cat?.maintainer, x.tml?.author, ...(x.op?.authors ?? [])].filter(Boolean).join(' ').toLowerCase();
        if (!who.includes(am[1].toLowerCase())) return false;
        scores.set(x.key, 1);
        return true;
      }
      const sc = fuzzyScore(q, [{ text: x.name, weight: 4 }, { text: x.cat?.author ?? x.tml?.author ?? x.op?.authors.join(' ') ?? '', weight: 2 }, { text: x.cats.join(' ') + ' ' + (x.cat?.modType ?? ''), weight: 2 }, { text: x.text, weight: 1 }]);
      if (sc === null) return false;
      scores.set(x.key, sc);
      return true;
    });
    const byName = (a: Row, b: Row) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    if (sort === 'name') r.sort(byName);
    if (sort === 'updated') r.sort((a, b) => b.updated.localeCompare(a.updated) || byName(a, b));
    if (sort === 'new') r.sort((a, b) => (b.first || b.updated).localeCompare(a.first || a.updated) || byName(a, b));
    if (sort === 'popular') r.sort((a, b) => b.pop - a.pop || byName(a, b));
    const opInstalled = opAllInstalled(hub.snapshot, hub.games);
    if (sort === 'installable') r.sort((a, b) => rankOf(a, opInstalled) - rankOf(b, opInstalled) || (q.trim() ? (scores.get(b.key) ?? 0) - (scores.get(a.key) ?? 0) : b.pop - a.pop) || byName(a, b));
    // Relevance with a search: best fuzzy score first (stable otherwise).
    if (sort === 'relevance' && q.trim()) r.sort((a, b) => (scores.get(b.key) ?? 0) - (scores.get(a.key) ?? 0));
    return r;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, view, q, sort, cats, games, srcs, status, coll, hub.snapshot]);
  const tmlList = useMemo(() => list.filter((x) => x.tml).map((x) => x.tml!), [list]);
  useEffect(() => { setShownN(PAGE); }, [view, q, sort, cats, games, srcs, status, coll]);

  const count = (pred: (r: Row) => boolean) => rows.filter((r) => inView(r) && pred(r)).length;
  const allCats = [...new Set(rows.flatMap((r) => r.cats))].sort();
  const allSrcs = [...new Set(mods.map((m) => m.source))].sort((a, b) => (a === 'Local database' ? 1 : b === 'Local database' ? -1 : a.localeCompare(b)));
  const profile = hub.profileFor('tmuf');
  const okServers = hub.index.servers.filter((s) => s.ok).length;
  const anyFacet = cats.size + games.size + srcs.size + status.size > 0;
  const resetAll = () => { clearCats(); clearGames(); clearSrcs(); clearStatus(); setQ(''); setColl(null); setView('all'); };
  const collRows = (ids: string[]) => { const set = new Set(ids.map(normId)); return rows.filter((r) => inView(r) && r.ids.some((i) => set.has(i))).length; };

  return (
    <div className="page wide">
      <div className="page-head">
        <div>
          <h1>{t('nav.mods')}</h1>
          <span className="dim">{t('mods.subAll', { n: mods.length, servers: okServers, more: catalogMods.length, ago: timeAgo(hub.index.fetchedAt) })}{opCount ? ` · Openplanet: ${opCount}` : ''}</span>
        </div>
        <div className="grow" />
        <div className="seg">
          <button className={tab === 'browse' ? 'on' : ''} onClick={() => setTab('browse')}>{t('mods.tabBrowse')}</button>
          <button className={tab === 'installed' ? 'on' : ''} onClick={() => setTab('installed')}>{t('common.installed')}</button>
          <button className={tab === 'tools' ? 'on' : ''} onClick={() => setTab('tools')}>{t('mods.tabTools')}</button>
        </div>
      </div>

      {tab === 'tools' ? <Tools /> : <div className="mods-layout">
        <aside className="facets">
          <Facet title={t('mods.facetGame')} sel={games} toggle={toggleGame}
            items={GAMES.map((g) => ({ ...g, n: count((r) => fitsGame(r.games, new Set([g.id]))) }))} />
          <Facet title={t('mods.facetCategory')} sel={cats} toggle={toggleCat}
            items={allCats.map((c) => ({ id: c, label: trOr('cat.' + c, c), n: count((r) => r.cats.includes(c)), icon: CAT_ICON[c] }))} />
          <Facet title={t('mods.facetStatus')} sel={status} toggle={toggleStatus}
            items={[
              { id: 'installed', label: t('common.installed'), n: count((r) => r.status === 'installed') },
              { id: 'update', label: t('mods.updateAvailable'), n: count((r) => r.status === 'update') },
              { id: 'available', label: t('common.notInstalled'), n: count((r) => r.status === 'available') },
            ]} />
          <Facet title={t('mods.facetSource')} sel={srcs} toggle={toggleSrc}
            items={[...allSrcs.map((s) => ({ id: s, label: s === 'Local database' ? t('mods.localDb') : s, n: count((r) => r.srcId === s) })), { id: COMMUNITY_SRC, label: t('mods.communityBadge'), n: count((r) => r.srcId === COMMUNITY_SRC) }, { id: CATALOG_SRC, label: t('mods.catalogBadge'), n: count((r) => r.srcId === CATALOG_SRC) }, { id: OPENPLANET_SRC, label: 'Openplanet', n: count((r) => r.srcId === OPENPLANET_SRC) }, ...(hub.mode === 'tas' ? [{ id: TAS_SRC, label: t('mods.tasBadge'), n: count((r) => r.srcId === TAS_SRC) }] : [])]} />
          {anyFacet && <button className="linkish small" onClick={() => { clearCats(); clearGames(); clearSrcs(); clearStatus(); }}>{t('mods.clear')}</button>}
        </aside>

        <div className="mods-main">
          <div className="toolbar">
            <label className="search grow">
              <Search size={16} />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('mods.search')} />
            </label>
            <label className="select">
              <span className="dim small">{t('mods.sort')}</span>
              <select value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
                <option value="installable">{t('mods.sortInstallable')}</option>
                <option value="relevance">{t('mods.sortRelevance')}</option>
                <option value="updated">{t('mods.sortUpdated')}</option>
                <option value="new">{t('mods.sortNew')}</option>
                <option value="popular">{t('mods.sortPopular')}</option>
                <option value="name">{t('mods.sortName')}</option>
              </select>
            </label>
            {/* Tiles (cards with description) or a compact list; remembered, default in Settings > Appearance. */}
            <div className="seg layout-seg" role="radiogroup" aria-label={t('mods.layout')}>
              <button role="radio" aria-checked={hub.look.modsView === 'tiles'} className={hub.look.modsView === 'tiles' ? 'on' : ''} title={t('mods.layoutTiles')} onClick={() => hub.setLook({ modsView: 'tiles' })}><LayoutGrid size={15} /> {t('mods.layoutTiles')}</button>
              <button role="radio" aria-checked={hub.look.modsView === 'list'} className={hub.look.modsView === 'list' ? 'on' : ''} title={t('mods.layoutList')} onClick={() => hub.setLook({ modsView: 'list' })}><List size={15} /> {t('mods.layoutList')}</button>
            </div>
          </div>

          {tab === 'browse' && COLLECTIONS.length > 0 && (
            <div className="coll-row" role="group" aria-label={t('mods.collections')}>
              <span className="dim small">{t('mods.collections')}</span>
              {COLLECTIONS.map((c) => ({ c, n: collRows(c.entries) })).filter((x) => x.n > 0 || coll === x.c.id).map(({ c, n }) => (
                <button key={c.id} className={'coll-chip' + (coll === c.id ? ' on' : '')} title={c.description} onClick={() => setColl(coll === c.id ? null : c.id)}>{c.name} <span className="dim">{n}</span></button>
              ))}
            </div>
          )}

          {tab === 'browse' && (
            <div className="seg view-seg">
              <button className={view === 'all' ? 'on' : ''} onClick={() => setView('all')}>{t('mods.viewAll')}</button>
              <button className={view === 'tmloader' ? 'on' : ''} onClick={() => setView('tmloader')}>TMLoader <span className="dim">{mods.length}</span></button>
              <button className={view === 'community' ? 'on' : ''} onClick={() => setView('community')}>{t('mods.communityBadge')} <span className="dim">{communityN}</span></button>
              <button className={view === 'openplanet' ? 'on' : ''} onClick={() => setView('openplanet')}>Openplanet{opCount ? <> <span className="dim">{opCount}</span></> : null}</button>
              <button className={view === 'horizon' ? 'on' : ''} onClick={() => setView('horizon')}>{t('hh.browseTitle')}</button>
            </div>
          )}

          {tab === 'browse' && view === 'horizon' && <HorizonPluginsBrowser />}
          {tab === 'browse' && view !== 'horizon' && (
            <div className={'modlist unified-list' + (hub.look.modsView === 'list' ? ' as-list' : '')}>
              {list.slice(0, shownN).map((row) => row.cat ? <CatalogCard key={row.key} c={row.cat} /> : row.op ? <OpCard key={row.key} p={row.op} /> : row.tml && ((m) => (
                <div className="modcard" key={m.id} onClick={() => go('mods', m.id)} role="button" tabIndex={0}>
                  <ModIcon mod={m} size={88} />
                  <div className="modcard-text">
                    <div className="modcard-title">
                      <b title={m.name}>{m.name}</b>
                      {m.author && <span className="dim">{tn('mods.by', { author: <span className="fg-2">{m.author}</span> })}</span>}
                      <SrcBadge src="tmloader" />
                    </div>
                    <p className="clamp2">{m.description?.trim() || t('mods.noDesc')}</p>
                    <div className="modcard-tags">
                      {m.categories.map((c) => <Cat key={c} c={c} />)}
                      <span className="sep" />
                      {m.games.map((g) => <GameChip key={g} id={g} />)}
                    </div>
                  </div>
                  <div className="modcard-stats">
                    <ActionButton m={m} />
                    <div className="stat-lines">
                      {m.downloads != null && <span title={t('mods.dlTip')}><Download size={13} /> <b>{fmtNum(m.downloads)}</b> {tp('mods.downloads', m.downloads)}</span>}
                      {m.stars != null && <span title={t('mods.starsTip')}><Star size={13} /> <b>{fmtNum(m.stars)}</b> {tp('mods.stars', m.stars)}</span>}
                      <span title={t('mods.versionsTip')}><Layers size={13} /> <b>{m.versionCount}</b> {tp('mods.versions', m.versionCount)}</span>
                      {m.size != null && <span title={t('mods.sizeTip')}><HardDrive size={13} /> {fmtSize(m.size)}</span>}
                      <span title={t('mods.latestTip')}><Package size={13} /> {m.latest ?? m.installedLatest ?? '-'}</span>
                    </div>
                    <span className="dim small upd"><RefreshCw size={12} /> {m.updated ? t('mods.updated', { ago: timeAgo(m.updated) }) : m.source === 'Local database' ? t('mods.notOnServer') : m.source}</span>
                  </div>
                </div>
              ))(row.tml))}
              {view !== 'tmloader' && view !== 'community' && !ops && Array.from({ length: list.length ? 2 : 4 }, (_, i) => (
                <div className="modcard skeleton" key={'sk' + i} aria-hidden><span className="mod-icon sk" style={{ width: 88, height: 88 }} /><div className="modcard-text"><span className="sk-line w40" /><span className="sk-line w90" /><span className="sk-line w60" /></div></div>
              ))}
              {list.length === 0 && (view === 'tmloader' || view === 'community' || ops) && (
                <div className="empty empty-rich">
                  <Search size={22} />
                  <b>{t('mods.noMatch')}</b>
                  {(q || anyFacet || coll || view !== 'all') && <button className="btn ghost sm" onClick={resetAll}><RotateCcw size={14} /> {t('mods.resetFilters')}</button>}
                </div>
              )}
            </div>
          )}
          {tab === 'browse' && view !== 'horizon' && list.length > shownN && <button className="btn ghost show-more" onClick={() => setShownN(shownN + PAGE)}>{t('op.more', { n: list.length - shownN })}</button>}
          {tab === 'installed' && <ModUpdates />}
          {tab === 'installed' && profile && (
            <section className="panel">
              <SectionHead title={t('mods.profileTitle', { name: profile.name })} sub={t('mods.profileSub')} />
              <div className="tiles">
                {foreverMods(tmlList).map((m) => <ModTile key={m.id} m={m} profile={profile} />)}
              </div>
            </section>
          )}
          {tab === 'installed' && <CatalogBackups />}
        </div>
      </div>}
    </div>
  );
}

/** A TMLoader mod that also has a standalone build in the catalog (Always Official): which variant is
 * installed, and the standalone install as an option. TMLoader is the recommended way. */
function VariantPanel({ m, entry }: { m: ModView; entry: (typeof CATALOG)[number] }) {
  const t = useT();
  const [recs, setRecs] = useState<InstallRecord[] | null>(null);
  const [dlg, setDlg] = useState(false);
  const load = () => { backend.modUpdates?.installs().then(setRecs).catch(() => setRecs([])); };
  useEffect(load, []);
  const spec = entry.installSpec!;
  const viaTml = m.installedVersions.length > 0;
  const alone = (recs ?? []).filter((r) => r.entryId === entry.id);
  return (
    <section className="panel">
      <SectionHead title={t('variant.title')} />
      <div className="side-block">
        <div className="variant-row"><Boxes size={14} /> <b className="grow">{t('variant.tmloader')}</b>{viaTml ? <span className="pill tiny ok">{t('variant.installed', { v: m.installedLatest ?? '' })}</span> : <span className="pill tiny">{t('variant.recommended')}</span>}</div>
        <div className="variant-row"><HardDrive size={14} /> <b className="grow">{t('variant.standalone')}</b>{alone.length ? <span className="pill tiny ok">{t('variant.installed', { v: alone[0].version })}</span> : <span className="dim small">{t('common.no')}</span>}</div>
        {viaTml && alone.length > 0 && <p className="small warn">{t('variant.both')}</p>}
        {spec.note && <p className="dim small">{spec.note}</p>}
        {isNative && backend.catalogMods && !alone.length && <button className="btn ghost sm" onClick={() => setDlg(true)}><Download size={14} /> {t('variant.installStandalone')}</button>}
      </div>
      {dlg && <CatalogInstallDialog entry={entry} spec={spec} onClose={() => { setDlg(false); load(); }} />}
    </section>
  );
}

function Tools() {
  // GitHub projects from the hub API that are not TMLoader mods: standalone tools, libraries, controllers.
  const hub = useHubState();
  const t = useT();
  const linked = new Set(hub.mods.map((m) => m.project?.id).filter(Boolean));
  // Projects the catalog lists as mods (Always Official, ESWC Autosave, BingoForever, ...) are mods, not tools.
  const modIds = new Set(CATALOG.filter((c) => c.category === 'mod').map((c) => c.id));
  const list = projectsFile.projects.filter((p) => !linked.has(p.id) && !p.archived && !(p.catalogIds ?? []).some((id) => modIds.has(id))).sort((a, b) => b.stars - a.stars);
  return (
    <div className="tools-grid">
      {list.map((p) => {
        const dl = releaseDownloads(p);
        return (
          <a className="tool" key={p.id} href={p.release?.url ?? p.url} target="_blank" rel="noreferrer">
            <div className="tool-top">
              <span className="mod-icon ph" style={{ width: 44, height: 44, fontSize: 15 }}>{p.name.replace(/[^A-Za-z]/g, '').slice(0, 2).toUpperCase()}</span>
              <div className="grow">
                <b>{p.name}</b>
                <div className="dim small ellip" title={p.id}>{p.id}</div>
              </div>
              {p.release && <span className="ver-badge">{p.release.tag}</span>}
            </div>
            <p className="dim clamp2">{p.description ?? t('mods.noDesc')}</p>
            <div className="tool-stats">
              <span><Star size={13} /> {fmtNum(p.stars)}</span>
              {dl != null && <span><Download size={13} /> {fmtNum(dl)}</span>}
              {p.language && <span><Code2 size={13} /> {p.language}</span>}
              {p.license && <span><Scale size={13} /> {p.license}</span>}
              <span className="grow" />
              {p.pushed && <span className="dim">{timeAgo(p.pushed)}</span>}
            </div>
          </a>
        );
      })}
    </div>
  );
}

export function ModDetail({ id }: { id: string }) {
  const hub = useHubState();
  const t = useT();
  const m = hub.mods.find((x) => x.id === id);
  const versions = m ? allVersions(m) : [];
  const repo = m ? repoUrlOf(m) : undefined;
  const releases = useReleases(repo);
  const [tab, setTab] = useState<'about' | 'changelog' | 'versions' | 'presets' | 'luts' | 'packs'>(repo ? 'about' : 'changelog');
  const [sel, setSel] = useState<string | null>(null);
  if (!m) {
    // Openplanet plugins (op:<id>) and catalog ids (tmhub://mod/<id>, tmhub://install/<id>) have their own page.
    if (id.startsWith('op:')) return <OpPluginPage id={Number(id.slice(3))} />;
    const c = catalogModById(id);
    const auto = linkIntent.install === id;
    if (auto) linkIntent.install = null;
    if (c) return <CatalogModPage c={c} autoInstall={auto} />;
    return (
      <div className="page">
        <button className="back inline" onClick={() => goBack(() => go('mods'))}><ArrowLeft size={16} /> {canGoBack() ? t('common.back') : t('nav.mods')}</button>
        <p>{t('mods.notFound')}</p>
      </div>
    );
  }
  const current = sel ?? versions[0];
  const deps = m.remote?.versions.find((v) => v.version === current)?.dependencies ?? m.local?.versions.find((v) => v.version === current)?.dependencies ?? [];
  const nrm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, '');
  const cat = CATALOG.find((c) => nrm(c.name) === nrm(m.name) || nrm(c.id.replace(/^mod-/, '')) === nrm(m.id));
  const compatGames = [...new Set([...m.games, ...(cat?.games ?? [])])];
  const installGroups = Object.entries(
    Object.entries(cat?.installs ?? {}).reduce<Record<string, string[]>>((acc, [g, how]) => { (acc[how] ??= []).push(g); return acc; }, {}),
  );
  const profile = hub.profileFor('tmuf');
  const used = profile?.mods.find((x) => x.id === m.id);
  return (
    <div className="page wide detail">
      <button className="back inline" onClick={() => goBack(() => go('mods'))}><ArrowLeft size={16} /> {canGoBack() ? t('common.back') : t('nav.mods')}</button>
      <div className={'detail-head panel' + (repo ? ' md-hero' : '')}>
        {repo && <HeroBg mod={m} />}
        <ModIcon mod={m} size={104} />
        <div className="detail-title">
          <h1>{m.name}</h1>
          <p className="dim clamp2">{m.description?.trim() || t('mods.noDesc')}</p>
          <div className="detail-stats">
            {m.downloads != null && <span><Download size={15} /> <b>{fmtNum(m.downloads)}</b> {tp('mods.downloads', m.downloads)}</span>}
            {m.stars != null && <span><Star size={15} /> <b>{fmtNum(m.stars)}</b> {tp('mods.stars', m.stars)}</span>}
            <span><Layers size={15} /> <b>{m.versionCount}</b> {tp('mods.versions', m.versionCount)}</span>
            {m.size != null && <span><HardDrive size={15} /> {fmtSize(m.size)}</span>}
            {m.updated && <span><RefreshCw size={15} /> {t('mods.updated', { ago: timeAgo(m.updated) })}</span>}
            <span className="cats">{m.categories.map((c) => <Cat key={c} c={c} />)}</span>
          </div>
        </div>
        <div className="detail-actions">
          <ActionButton m={m} big />
          {m.homepage && <a className="btn ghost" href={m.homepage} target="_blank" rel="noreferrer" title={m.homepage}><ExternalLink size={15} /> {t('mods.website')}</a>}
        </div>
      </div>

      {(() => {
        const sc = showcaseFor(m.id, m.name, cat?.id);
        const links = relatedLinksOf(m.id, m.name, cat?.id);
        return sc ? <ModShowcase showcase={sc} onInstall={clickInstall} companion={companionOf(links)}
          releases={versions.slice(0, 3).map((v) => ({ version: v, notes: changelogFor(m, v) || releaseFor(releases, v)?.notes || '', date: releaseFor(releases, v)?.date ?? null }))} /> : null;
      })()}

      <RelatedSection links={relatedLinksOf(m.id, m.name, cat?.id)} />

      {/* A showcase with its own gallery replaces the README's picture strip (the same pictures twice, plus old ones). */}
      {!showcaseFor(m.id, m.name, cat?.id)?.blocks.some((b) => b.type === 'gallery') && <ModGallery mod={m} />}

      <div className="detail-tabs">
        <div className="tabs">
          <button className={tab === 'about' ? 'on' : ''} onClick={() => setTab('about')}>{t('mods.tabDescription')}</button>
          <button className={tab === 'changelog' ? 'on' : ''} onClick={() => setTab('changelog')}>{t('mods.tabChangelog')}</button>
          <button className={tab === 'versions' ? 'on' : ''} onClick={() => setTab('versions')}>{t('mods.tabVersions')} <span className="dim">{versions.length || releases?.length || 0}</span></button>
          {m.id === TMVS_ID && (['presets', 'luts', 'packs'] as const).map((k) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{t('tmvs.tab.' + (k === 'presets' ? 'preset' : k === 'luts' ? 'lut' : 'pack'))}</button>)}
        </div>
      </div>

      {m.id === TMVS_ID && (tab === 'presets' || tab === 'luts' || tab === 'packs') && <TmvsContent key={tab} kind={tab === 'presets' ? 'preset' : tab === 'luts' ? 'lut' : 'pack'} />}
      {!(m.id === TMVS_ID && (tab === 'presets' || tab === 'luts' || tab === 'packs')) && <div className="detail-grid">
        <div className="col">
          {tab === 'about' && repo && <ReadmeView repo={repo} fallback={m.description?.trim() || t('mods.noDesc')} title={m.name} />}
          {tab === 'about' && !repo && <section className="panel"><p className="lead">{m.description?.trim() || t('mods.noDesc')}</p></section>}
          {tab === 'changelog' && (
            <section className="panel">
              <div className="cl-head">
                <span className="ver-badge">{current}</span>
                {current === m.latest && <span className="pill tiny">{t('mods.latest')}</span>}
                {m.installedVersions.includes(current) && <span className="pill tiny ok">{t('common.installed')}</span>}
              </div>
              {changelogFor(m, current)
                ? <pre className="changelog">{changelogFor(m, current)}</pre>
                : releaseFor(releases, current) ? <ReleaseNotes release={releaseFor(releases, current)!} /> : <p className="dim">{t('mods.noChangelog')}</p>}
            </section>
          )}
          {tab === 'versions' && (
            <section className="panel">
              {versions.length > 0 && <ul className="versions">
                {versions.map((v) => (
                  <li key={v} className={v === current ? 'on' : ''} onClick={() => { setSel(v); setTab('changelog'); }}>
                    <span className="ver-badge">{v}</span>
                    {v === m.latest && <span className="pill tiny">{t('mods.latest')}</span>}
                    <span className="grow" />
                    {m.installedVersions.includes(v) && <span className="small acc-text">{used?.version === v ? t('mods.fixedInProfile') : t('common.installed')}</span>}
                  </li>
                ))}
              </ul>}
              {repo && (
                <div className="md-rel-section">
                  <h3 className="md-rel-title">{t('moddetail.releases')}</h3>
                  <ReleasesList list={releases} />
                </div>
              )}
            </section>
          )}
        </div>
        <div className="col side">
          <section className="panel">
            <SectionHead title={t('mods.compat')} />
            <div className="side-block"><span className="dim small">{t('mods.games')}</span><div className="modcard-tags">{compatGames.map((g) => <GameChip key={g} id={g} />)}</div></div>
            {installGroups.length > 0 ? (
              <div className="side-block">
                <span className="dim small">{t('mods.installedVia')}</span>
                <div className="compat-install">
                  {installGroups.map(([how, gs]) => (
                    <div className="row" key={how}>
                      <span className="modcard-tags">{gs.map((g) => <GameChip key={g} id={g} />)}</span>
                      <span className="cat"><Boxes size={12} /> {how === 'tmloader' ? 'TMLoader' : t('mods.installProxy', { dll: how.replace(/^proxy:/, ''), exe: gs[0].startsWith('tm2') ? 'ManiaPlanet.exe' : gs[0] === 'eswc' ? 'TmNationsESWC.exe' : 'the game exe' })}</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : <div className="side-block"><span className="dim small">{t('mods.loader')}</span><div><span className="cat"><Boxes size={12} />TMLoader</span></div></div>}
            <div className="side-block">
              <span className="dim small">{t('mods.needs', { v: current })}</span>
              {deps.length
                ? <ul className="deps">{deps.map((d) => <li key={d.id}><button className="linkish" onClick={() => go('mods', d.id)}>{d.id === 'TmForever' ? 'TrackMania Modded Forever' : d.id}</button> <span className="mono dim">{d.version ?? t('mods.any')}</span></li>)}</ul>
                : <div className="small">{t('mods.nothingElse')}</div>}
            </div>
          </section>
          {cat?.installSpec && <VariantPanel m={m} entry={cat} />}
          <section className="panel">
            <SectionHead title={t('mods.creators')} />
            <div className="creator"><span className="ava"><User size={16} /></span><div><b>{m.author ?? t('mods.unknown')}</b><div className="dim small">{t('mods.author')}</div></div></div>
          </section>
          <section className="panel">
            <SectionHead title={t('mods.details')} />
            <dl className="kv">
              <dt>{t('game.source')}</dt><dd className="ellip" title={m.source}><Globe size={12} /> {m.source}</dd>
              <dt>{t('common.installed')}</dt><dd>{m.installedVersions.length ? m.installedVersions.slice(0, 4).join(', ') + (m.installedVersions.length > 4 ? ' …' : '') : t('common.no')}</dd>
              <dt>{t('mods.inProfile')}</dt><dd>{used ? `"${profile?.name}"${used.version ? ` (${t('common.fixedVer', { v: used.version })})` : ''}` : t('common.no')}</dd>
              {m.sha256 && <><dt>SHA-256</dt><dd className="mono ellip" title={m.sha256}>{m.hashOk ? <span className="good"><ShieldCheck size={12} /> </span> : null}{m.sha256.slice(0, 16)}…</dd></>}
              {m.project?.license && <><dt>{t('mods.license')}</dt><dd>{m.project.license}</dd></>}
            </dl>
            {m.project && <a className="btn ghost sm" href={m.project.url} target="_blank" rel="noreferrer"><Github size={14} /> {m.project.id}</a>}
          </section>
        </div>
      </div>}
    </div>
  );
}
