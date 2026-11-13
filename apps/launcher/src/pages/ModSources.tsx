// More sources for the Mods page next to the TMLoader servers: mods from the catalog that are not on
// any TMLoader server (GitHub releases, forums, ...), and Openplanet plugins from openplanet.dev's
// public API for Trackmania (2020) and ManiaPlanet. Cards use the same layout as the TMLoader mods
// and are merged into one list by pages/Mods.tsx. The catalog is bundled, so it also works offline.
import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Download, ExternalLink, MessageCircle, ShieldAlert, ShieldCheck, Users } from 'lucide-react';
import { OpInstalledActions, OpPluginActions } from '../ui/OpPluginActions';
import { CatalogInstallDialog } from '../ui/CatalogInstall';
import { CATALOG, communitiesFile, fmtNum } from '../data/hub';
import { backend, isNative, type OpInstalledInfo, type OpPlugin, type ProxyScan } from '../data/backend';
import { go, useHubState } from '../state';
import { CachedImg, GameChip, useCachedImage } from '../ui/common';
import { GenIcon, glyphForEntry } from '../ui/GenIcon';
import { useT } from '../i18n';
import type { CatalogEntry } from '@tm-hub/shared';

/** Catalog ids that are pages about a mod, not a mod (sites, plugin lists, the loader itself). */
const NOT_MODS = new Set(['tmloader', 'tmloader-site', 'twinkie-site', 'twinkie-org', 'openplanet-plugins', 'openplanet-nl-old']);
/** Catalog mods installed through the ESWC proxy-DLL dialog (eswcmods.rs), not through an installSpec. */
export const ESWC_PROXY_IDS = new Set(['mod-eswc-autosave']);
/** The Openplanet loader itself (installed with its official installer, ui/OpenplanetSetup.tsx). */
export const OPENPLANET_ID = 'openplanet';
/** Can TM Horizon install this catalog entry itself (file install, ESWC dialog, Openplanet installer)? */
/** Openplanet games on this PC and whether Openplanet is installed for each (scan: Openplanet.dll next to the exe). */
export function opGamesState(snap: { openplanet: Record<string, { installed: boolean }> }, games: { id: string; installed: boolean }[]): { game: string; installed: boolean }[] {
  return ([['tm2020', 'tm2020'], ['maniaplanet', 'tm2-stadium']] as const)
    .filter(([, gid]) => games.some((g) => g.installed && (g.id === gid || (gid === 'tm2-stadium' && g.id.startsWith('tm2-')) || (gid === 'tm2-stadium' && g.id === 'sm-storm'))))
    .map(([key]) => ({ game: key, installed: !!snap.openplanet[key]?.installed }));
}
/** True when every Openplanet game on this PC has Openplanet (and there is at least one). */
export const opAllInstalled = (snap: { openplanet: Record<string, { installed: boolean }> }, games: { id: string; installed: boolean }[]) => {
  const s = opGamesState(snap, games);
  return s.length > 0 && s.every((x) => x.installed);
};

export const catalogInstallable = (c: { id: string; installSpec?: unknown }) => !!c.installSpec || ESWC_PROXY_IDS.has(c.id) || c.id === OPENPLANET_ID;
/** Catalog game ids -> launcher game ids. */
const GAME_IDS: Record<string, string> = { eswc: 'tmn-eswc', tmo: 'tm-original', tms: 'tm-sunrise', turbo: 'tm-turbo', tm1: 'tm-original', tmsx: 'tm-sunrise', tmu2006: 'tmuf' };
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

/** Source facet value for the community-listed entries (Discord modding channel export). */
export const COMMUNITY_SRC = 'community-listed';
/** Entries of the community Discord's mod export carry a hosting field; nothing else does. */
const isCommunity = (c: CatalogEntry) => !!c.hosting;
export type CatalogMod = Omit<CatalogEntry, 'games'> & { games: string[]; community: boolean };

/** Catalog mods and community-listed entries (mods, skins, tools, environments) that the TMLoader index
 * does not list. A mod shown once (TMLoader card, installable) never comes back as a community card;
 * the catalog's extra data (standalone build, links) is on the TMLoader mod's page. */
export function useCatalogMods(): CatalogMod[] {
  const hub = useHubState();
  const tas = hub.mode === 'tas';
  return useMemo(() => {
    const known = new Set(hub.mods.flatMap((m) => [norm(m.id), norm(m.name)]));
    const isKnown = (c: CatalogEntry) => known.has(norm(c.name)) || known.has(norm(c.id.replace(/^mod-/, '')));
    const fix = (c: CatalogEntry): CatalogMod => ({ ...c, community: isCommunity(c), games: [...new Set(c.games.map((g) => GAME_IDS[g] ?? g))] });
    const seen = new Set<string>();
    return CATALOG.filter((c) => (isCommunity(c) && ['mod', 'skins', 'tool', 'environment'].includes(c.category) && !isKnown(c))
      || (c.category === 'tas-plugin' && tas)
      || (c.category === 'mod' && !NOT_MODS.has(c.id) && !isKnown(c)))
      // The same mod twice in the catalog (two source lists) is shown once.
      .filter((c) => { const k = norm(c.name); if (seen.has(k)) return false; seen.add(k); return true; })
      .map(fix);
  }, [hub.mods, tas]);
}

/** Openplanet plugins from openplanet.dev's list; loaded once (the app caches it), only when `enabled`.
 * null while loading, [] in the browser preview. */
let opCache: OpPlugin[] | null = null;
export function useOpPlugins(enabled: boolean): OpPlugin[] | null {
  const [all, setAll] = useState<OpPlugin[] | null>(opCache);
  useEffect(() => {
    if (!enabled || opCache) return;
    if (!backend.openplanet) { setAll([]); return; }
    backend.openplanet.catalog().then((l) => { opCache = l; setAll(l); }).catch(() => setAll([]));
  }, [enabled]);
  return all;
}

/** Number of Openplanet plugins in openplanet.dev's list (0 until loaded and in the browser preview). */
export function useOpCount() {
  return useOpPlugins(true)?.length ?? 0;
}

/** Facet game ("maniaplanet" covers every TM² title) -> does the entry fit? */
export const fitsGame = (games: string[], sel: Set<string>) => !sel.size || games.some((g) => sel.has(g) || (sel.has('maniaplanet') && (g.startsWith('tm2-') || g === 'sm-storm')));

/** The modding Discord the export comes from is not named in the catalog; the community list's
 * "TM Modding Community" is the closest entry and serves as the link for Discord-only files. */
const MOD_DISCORD = () => communitiesFile.communities.find((c) => c.id === 'dir:tm-modding-community');

/** Number of community-listed entries (before search and game filters). */
export function useCommunityCount() {
  return useCatalogMods().filter((c) => c.community).length;
}

/** Source of a card in the unified list. */
export type ModSource = 'tmloader' | 'community' | 'catalog' | 'openplanet' | 'tas' | 'hub';
/** Source of a catalog card: TM Horizon Hub entries (hosting "tmhub") get their own badge. */
export const catalogSrc = (c: { id?: string; category: string; community: boolean; hosting?: string | null }): ModSource =>
  c.id === 'openplanet' ? 'openplanet' : c.hosting === 'tmhub' ? 'hub' : c.category === 'tas-plugin' ? 'tas' : c.community ? 'community' : 'catalog';

export function SrcBadge({ src }: { src: ModSource }) {
  const t = useT();
  const label = src === 'tmloader' ? 'TMLoader' : src === 'openplanet' ? 'Openplanet' : src === 'hub' ? 'Hub' : src === 'community' ? t('mods.communityBadge') : src === 'tas' ? t('mods.tasBadge') : t('mods.catalogBadge');
  const tip = src === 'community' ? t('mods.communityTip') : src === 'catalog' ? t('mods.catalogTip') : src === 'hub' ? t('mods.hubTip') : undefined;
  return <span className={'pill tiny src-badge src-' + src} title={tip}>{label}</span>;
}

/** Own logos of catalog entries that have no picture in the catalog (the Openplanet loader). */
const LOCAL_ICONS: Record<string, string> = __PUBLIC_BUILD__ ? {} : { [OPENPLANET_ID]: 'mod-icons/openplanet.png' };
/** A catalog entry's own logo (local logo, add-on icon), or null: then the generated tile is shown. */
export const catalogIcon = (c: { id: string; addon?: { icon?: string | null } | null }): string | null => LOCAL_ICONS[c.id] ?? c.addon?.icon ?? null;

/** Card picture: the entry's own logo, else the website's generated tile (also while the logo is missing or failed). */
export function CatalogIcon({ c, size = 88 }: { c: { id: string; name: string; category: string; modType?: string | null; addon?: { icon?: string | null } | null }; size?: number }) {
  const fb = <GenIcon seed={c.id} glyph={glyphForEntry(c)} size={size} />;
  const url = catalogIcon(c);
  return url ? <CachedImg url={url} className="tile-icon" style={{ width: size, height: size }} fallback={fb} /> : fb;
}

/** Openplanet plugin picture (openplanet.dev's thumbnail), else the generated tile. */
function TileIcon({ url, name }: { url: string | null | undefined; name: string }) {
  const fb = <GenIcon seed={name} glyph="puzzle" size={88} />;
  return url ? <CachedImg url={url} className="tile-icon" style={{ width: 88, height: 88 }} fallback={fb} /> : fb;
}

/** A catalog entry by id as a card model (game ids mapped), for tmhub:// links and catalog pages. */
export function catalogModById(id: string): CatalogMod | null {
  const c = CATALOG.find((x) => x.id === id);
  return c ? { ...c, community: isCommunity(c), games: [...new Set(c.games.map((g) => GAME_IDS[g] ?? g))] } : null;
}

/** ESWC proxy-DLL mods found next to TmNationsESWC.exe (read-only scan, once per app start). */
let eswcScan: Promise<ProxyScan | null> | null = null;
export function useEswcInstalled(modName: string | null): ProxyScan['mods'][number] | null {
  const hub = useHubState();
  const [m, setM] = useState<ProxyScan['mods'][number] | null>(null);
  const eswc = hub.games.some((g) => g.id === 'tmn-eswc' && g.installed);
  useEffect(() => {
    if (!modName || !eswc || !backend.proxyMods) return;
    eswcScan ??= backend.proxyMods('tmn-eswc').catch(() => null);
    let live = true;
    eswcScan.then((s) => { if (live) setM(s?.mods.find((x) => x.id === modName) ?? null); });
    return () => { live = false; };
  }, [modName, eswc]);
  return m;
}
/** Catalog id -> name of the mod in the ESWC proxy scan. */
const ESWC_PROXY_NAME: Record<string, string> = { 'mod-eswc-autosave': 'ESWC Autosave' };

export function CatalogCard({ c, autoInstall = false }: { c: CatalogMod; autoInstall?: boolean }) {
  const t = useT();
  const hub = useHubState();
  const op = c.id === OPENPLANET_ID ? opGamesState(hub.snapshot, hub.games) : [];
  const opDone = op.length > 0 && op.every((x) => x.installed);
  const eswcHave = useEswcInstalled(ESWC_PROXY_NAME[c.id] ?? null);
  const [dlg, setDlg] = useState(autoInstall && isNative && !!backend.catalogMods && !!c.installSpec);
  const url = c.url ?? c.urls?.[0] ?? null;
  const discord = !url ? MOD_DISCORD() : undefined;
  const hint = c.install === 'skins' ? t('mods.hintSkins') : c.install === 'unlimiter-required' ? t('mods.hintUnlimiter') : c.install && c.install !== 'manual' ? c.install : null;
  const spec = isNative && backend.catalogMods ? c.installSpec ?? null : null;
  const note = c.installSpec === null ? c.downloadNote : null;
  const special = ESWC_PROXY_IDS.has(c.id) || c.id === OPENPLANET_ID;
  const stop = (f: () => void) => (e: React.MouseEvent) => { e.stopPropagation(); f(); };
  return (
    <div className="modcard" role="button" tabIndex={0} onClick={() => go('mods', c.id)} onKeyDown={(e) => { if (e.key === 'Enter' && e.target === e.currentTarget) go('mods', c.id); }}>
      <CatalogIcon c={c} />
      <div className="modcard-text">
        <div className="modcard-title">
          <b title={c.name}>{c.name}</b>{(c.author ?? c.maintainer) && <span className="dim">{c.author ?? c.maintainer}</span>}
          <SrcBadge src={catalogSrc(c)} />
        </div>
        <p className="clamp2">{c.description}</p>
        <div className="modcard-tags">{c.games.map((g) => <GameChip key={g} id={g} />)}{c.modType && <span className="cat">{c.modType}</span>}{hint && <span className="dim small ellip" title={hint}>{hint}</span>}</div>
        {!url && c.community && <div className="dim small">{note ?? t('mods.discordOnly')}</div>}
        {url && note && <div className="dim small clamp2" title={note}>{note}</div>}
      </div>
      <div className="modcard-stats catalog-btns">
        {spec && <button className="btn primary sm" onClick={stop(() => setDlg(true))} title={spec.note ?? t('catinst.tip')}><Download size={14} /> {t('common.install')}</button>}
        {eswcHave && <span className="pill tiny ok" title={eswcHave.file}><CheckCircle2 size={12} /> {t('common.installed')}{eswcHave.version ? ` ${eswcHave.version}` : ''}</span>}
        {op.filter((x) => x.installed).length > 0 && <span className="pill tiny ok"><CheckCircle2 size={12} /> {t('common.installed')} · {op.filter((x) => x.installed).map((x) => (x.game === 'tm2020' ? 'Trackmania' : 'ManiaPlanet')).join(', ')}</span>}
        {special && isNative && !eswcHave && !opDone && <button className="btn primary sm" onClick={stop(() => go('mods', c.id))} title={t('mods.installOnPage')}><Download size={14} /> {t('common.install')}</button>}
        {url
          ? <button className="btn ghost sm" onClick={stop(() => backend.openExternal(url))} title={note ? `${note}\n${url}` : url}><ExternalLink size={14} /> {spec || special ? t('mods.openLink') : t('mods.openPage')}</button>
          : c.community && (
            <>
              {discord && <button className="btn ghost sm" onClick={stop(() => backend.openExternal(discord.url))} title={discord.url}><MessageCircle size={14} /> {t('mods.openDiscord')}</button>}
              <button className="btn ghost sm" onClick={stop(() => go('community'))}><Users size={14} /> {t('mods.communityPage')}</button>
            </>
          )}
      </div>
      {dlg && spec && <span className="dlg-host" onClick={(e) => e.stopPropagation()}><CatalogInstallDialog entry={c} spec={spec} onClose={() => setDlg(false)} /></span>}
    </div>
  );
}

/** Launcher game whose Openplanet folder a plugin installs into. */
export const opGameOf = (p: OpPlugin) => (p.games.includes('Trackmania') ? 'tm2020' : 'tm2-stadium');
/** Openplanet's game names -> launcher game ids (for chips and the game facet). */
export const opGameIds = (p: OpPlugin): string[] => [...new Set(p.games.flatMap((g) => {
  const l = g.toLowerCase();
  return l === 'trackmania' ? ['tm2020'] : l.startsWith('maniaplanet') ? ['tm2-stadium', 'tm2-canyon', 'tm2-valley', 'tm2-lagoon'] : l.includes('turbo') ? ['tm-turbo'] : [];
}))];

export function OpCard({ p, page = false }: { p: OpPlugin; page?: boolean }) {
  const t = useT();
  const stop = (f: () => void) => (e: React.MouseEvent) => { e.stopPropagation(); f(); };
  return (
    <div className={'modcard' + (page ? ' op-page' : '')} role={page ? undefined : 'button'} tabIndex={page ? undefined : 0} onClick={page ? undefined : () => go('mods', 'op:' + p.id)}>
      <TileIcon url={p.image} name={p.name || 'OP'} />
      <div className="modcard-text">
        <div className="modcard-title"><b title={p.name}>{p.name}</b><span className="dim">{p.authors.join(', ')}</span><SrcBadge src="openplanet" /></div>
        <p className="clamp2">{p.short}</p>
        <div className="modcard-tags">
          {opGameIds(p).slice(0, 4).map((g) => <GameChip key={g} id={g} />)}
          {p.signed
            ? <span className="pill tiny ok-pill" title={t('op.signedTip')}><ShieldCheck size={11} /> {t('op.signed')}{p.signType && p.signType !== 'regular' ? ` (${p.signType})` : ''}</span>
            : <span className="pill tiny warn-pill" title={t('op.unsignedTip')}><ShieldAlert size={11} /> {t('op.unsigned')}</span>}
          <span className="dim small">{p.version}</span>
          <span className="dim small"><Download size={12} /> {fmtNum(p.downloads)}</span>
        </div>
        {page && <OpPluginActions p={p} layout="page" />}
      </div>
      <div className="modcard-stats">
        {!page && <OpPluginActions p={p} />}
        {!isNative && <span className="dim small">{t('op.onlyApp')}</span>}
        <button className="btn ghost sm" onClick={stop(() => backend.openExternal(p.page))}><ExternalLink size={14} /> openplanet.dev</button>
      </div>
    </div>
  );
}

/** Plugins really installed in the game's Openplanet folder, named from openplanet.dev's list.
 * Openplanet has no profiles: it loads every installed plugin, so there are no switches here. */
export function OpInstalledPlugins({ game, compact }: { game: string; compact?: boolean }) {
  const t = useT();
  const [inst, setInst] = useState<OpInstalledInfo | null>(null);
  const [cat, setCat] = useState<OpPlugin[]>([]);
  useEffect(() => {
    backend.openplanet?.installed(game).then(setInst).catch(() => setInst(null));
    backend.openplanet?.catalog().then(setCat).catch(() => {});
  }, [game]);
  if (!backend.openplanet) return <p className="dim small">{t('op.onlyApp')}</p>;
  if (!inst) return null;
  if (!inst.openplanet) return <p className="dim small">{t('op.missing')}</p>;
  if (!inst.plugins.length) return <p className="dim small">{t('op.none')}</p>;
  if (!compact) {
    // Game page: one row per plugin with its version, Update when openplanet.dev has a newer one, and Remove.
    return (
      <div className="op-installed">
        {inst.plugins.map((p) => {
          const c = cat.find((x) => x.identifier.toLowerCase() === p.identifier.toLowerCase());
          return (
            <div key={p.file} className="op-installed-row">
              <OpInstalledTile name={c?.name ?? p.identifier} version={p.version ?? (p.isDir ? t('op.devFolder') : c?.version ?? '')} image={c?.image ?? null} compact />
              {c && <OpInstalledActions p={c} game={game} />}
            </div>
          );
        })}
      </div>
    );
  }
  return (
    <div className="pd-mods">
      {inst.plugins.map((p) => {
        const c = cat.find((x) => x.identifier.toLowerCase() === p.identifier.toLowerCase());
        return <OpInstalledTile key={p.file} name={c?.name ?? p.identifier} version={p.version ?? c?.version ?? (p.isDir ? t('op.devFolder') : '')} image={c?.image ?? null} compact />;
      })}
    </div>
  );
}

function OpInstalledTile({ name, version, image, compact }: { name: string; version: string; image: string | null; compact?: boolean }) {
  const img = useCachedImage(image);
  const icon = img ? <img className="mod-icon" src={img} alt="" style={{ width: compact ? 32 : 52, height: compact ? 32 : 52, objectFit: 'cover' }} />
    : <span className="mod-icon ph" style={{ width: compact ? 32 : 52, height: compact ? 32 : 52, fontSize: compact ? 12 : 18 }}>{name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase()}</span>;
  return compact
    ? <div className="pd-mod">{icon}<span className="grow"><b>{name}</b> <span className="dim small">{version}</span></span></div>
    : <div className="tile on">{icon}<b className="tile-name" title={name}>{name}</b><span className="tile-ver">{version}</span></div>;
}
