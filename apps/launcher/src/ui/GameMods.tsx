// Game page building blocks with one structure for every game:
// - GameModsSection: what is installed for this game (TMLoader profile mods, ESWC/legacy proxy-DLL mods,
//   Openplanet plugins; file installs with update/undo come from ModUpdates) and "Available for this game"
//   from the catalog (installable first, link-only legacy mods marked), plus a link to the Mods page
//   pre-filtered to the game.
// - InstallationsCard: every folder found for the game, which one Play uses, open, add and remove.
// - CommandLine: a long command or path on one line (middle ellipsis), full text in the tooltip, copy button.
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ArrowRight, ChevronDown, ChevronRight, Copy, Download, ExternalLink, EyeOff, FolderOpen, FolderPlus, Loader2, Play, Trash2 } from 'lucide-react';
import { go, loadPref, savePref, useHubState } from '../state';
import { backend, isNative, type MoreProject } from '../data/backend';
import type { GameView } from '../data/types';
import { useT } from '../i18n';
import { SectionHead } from './common';
import { CatalogIcon, catalogInstallable, fitsGame, useCatalogMods, useOpPlugins, type CatalogMod } from '../pages/ModSources';
import { matchOpPlugin } from '../data/opPlugins';
import { OpPluginActions } from './OpPluginActions';

/** Games with Openplanet (its plugins appear only on their pages). */
const opGame = (g: string) => g === 'tm2020' || g === 'tm-turbo' || g.startsWith('tm2-') || g === 'sm-storm';
import { installsOf, useSelectedInstall } from './InstallPicker';
import { modsIntent } from '../data/hub';

/** "C:\Very\Long\Folder\Game.exe" -> "C:\Very\…\Game.exe" for one line; the full text stays in the tooltip. */
export function middleEllipsis(s: string, max = 46): string {
  if (s.length <= max) return s;
  const keep = max - 1;
  const tail = Math.ceil(keep * 0.6);
  return s.slice(0, keep - tail) + '…' + s.slice(s.length - tail);
}

/** Last folder name of a path ("…\TrackMania Sunrise"). */
export const folderName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

export function CommandLine({ text, max = 46 }: { text: string; max?: number }) {
  const hub = useHubState();
  const t = useT();
  return (
    <span className="one-line">
      <code title={text}>{middleEllipsis(text, max)}</code>
      <button className="btn icon tiny" title={t('common.copy')} aria-label={t('common.copy')}
        onClick={() => { navigator.clipboard?.writeText(text).catch(() => {}); hub.toast({ message: t('common.copied') }); }}><Copy size={13} /></button>
    </span>
  );
}

/** Opens the Mods page filtered to this game. */
export const openModsFor = (game: string) => { modsIntent.game = game; go('mods'); };

/** Mods page facet id of a launcher game (TM² titles share one facet). */
export const facetOf = (game: string) => (game.startsWith('tm2-') || game === 'sm-storm' ? 'maniaplanet' : game);

function AvailableRow({ c }: { c: CatalogMod }) {
  const t = useT();
  const url = c.url ?? c.urls?.[0] ?? null;
  const can = catalogInstallable(c) && isNative;
  return (
    <div className="gm-row" role="button" tabIndex={0} onClick={() => go('mods', c.id)} onKeyDown={(e) => { if (e.key === 'Enter') go('mods', c.id); }} title={c.description ?? undefined}>
      <CatalogIcon c={c} size={36} />
      <span className="grow min0">
        <b className="ellip">{c.name}</b>
        <span className="dim small ellip">{[c.author ?? c.maintainer, c.modType].filter(Boolean).join(' · ')}</span>
      </span>
      {can
        ? <button className="btn primary sm" onClick={(e) => { e.stopPropagation(); go('mods', c.id); }}><Download size={14} /> {t('common.install')}</button>
        : <>
            <span className="pill tiny muted" title={t('gm.linkOnlyTip')}>{t('addons.linkOnly')}</span>
            {url && <button className="btn ghost sm icon" title={url} aria-label={t('mods.openPage')} onClick={(e) => { e.stopPropagation(); backend.openExternal(url); }}><ExternalLink size={14} /></button>}
          </>}
    </div>
  );
}

/** The Mods section of a game page. `installed` is the game's own installed list (profile tiles, proxy mods, plugins). */
export function GameModsSection({ g, title, sub, installed, actions, footer, installedNames = [] }: { g: GameView; title?: string; sub?: ReactNode; installed: ReactNode; actions?: ReactNode; footer?: ReactNode; installedNames?: string[] }) {
  const t = useT();
  const all = useCatalogMods();
  // Horizon Client in the copy Play starts: the standalone loaders it includes (Legacy Essentials) are not offered.
  const [inClient, setInClient] = useState(false);
  useEffect(() => {
    setInClient(false);
    if (!['tmn-eswc', 'tm-sunrise', 'tm-original'].includes(g.id) || !backend.horizon) return;
    let live = true;
    const sel = g.install?.path?.toLowerCase();
    backend.horizon.targets(g.id).then((l) => { if (live) setInClient(l.some((c) => c.dir.toLowerCase() === sel && !!c.hostInstalled)); }).catch(() => undefined);
    return () => { live = false; };
  }, [g.id, g.install?.path]);
  const avail = useMemo(() => {
    const sel = new Set([facetOf(g.id)]);
    // Already installed (e.g. ESWC Autosave found next to the exe) is listed above, not again here.
    const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, '');
    const have = new Set(installedNames.map(norm));
    const list = all.filter((c) => (fitsGame(c.games, sel) || c.games.includes(g.id)) && !have.has(norm(c.name)) && !(inClient && (c.installSpec?.starForceBlocked?.length ?? 0) > 0));
    // Installable first, then link-only; inside each by name.
    return list.sort((a, b) => Number(catalogInstallable(b)) - Number(catalogInstallable(a)) || a.name.localeCompare(b.name));
  }, [all, g.id, installedNames.join('|'), inClient]); // eslint-disable-line react-hooks/exhaustive-deps
  // Cards (default) or compact rows, remembered for the player (all game pages).
  const [asList, setAsList] = useState(() => loadPref('tmhub.gameModsView') === 'list');
  const view = (list: boolean) => { setAsList(list); savePref('tmhub.gameModsView', list ? 'list' : 'cards'); };
  return (
    <section className={'panel game-mods' + (asList ? ' as-list' : '')}>
      <SectionHead title={title ?? t('nav.mods')} sub={sub}
        right={<>
          <div className="seg sm" role="radiogroup" aria-label={t('gm.view')}>
            <button role="radio" aria-checked={!asList} className={!asList ? 'on' : ''} onClick={() => view(false)}>{t('gm.viewCards')}</button>
            <button role="radio" aria-checked={asList} className={asList ? 'on' : ''} onClick={() => view(true)}>{t('gm.viewList')}</button>
          </div>
          {actions}<button className="btn ghost sm" onClick={() => openModsFor(g.id)}>{t('gm.allFor', { game: g.short })} <ArrowRight size={14} /></button></>} />
      <h4 className="gm-sub">{t('gm.installed')}</h4>
      {installed}
      {footer}
      <h4 className="gm-sub">{t('gm.available')} <span className="dim">{avail.length}</span></h4>
      {avail.length === 0
        ? <p className="dim small">{t('gm.noneAvailable')}</p>
        : <div className="gm-list">{avail.slice(0, 6).map((c) => <AvailableRow key={c.id} c={c} />)}</div>}
      {avail.length > 6 && <button className="linkish small gm-more" onClick={() => openModsFor(g.id)}>{t('gm.more', { n: avail.length - 6 })}</button>}
      <MoreProjects game={g.id} known={all} />
    </section>
  );
}

/** "More projects": link-only GitHub projects the hub lists for this game (name, short text, one link to
 * GitHub or openplanet.dev; no pictures). Openplanet plugins found on openplanet.dev (page or identifier)
 * get Install / Update / Remove there; everything else is a link. Closed by default; hidden when empty. */
function MoreProjects({ game, known }: { game: string; known: CatalogMod[] }) {
  const t = useT();
  const [list, setList] = useState<MoreProject[] | null>(null);
  const [open, setOpen] = useState(() => loadPref('tmhub.moreProjects') === 'open');
  const opCatalog = useOpPlugins(open && opGame(game));
  useEffect(() => {
    let live = true;
    setList(null);
    backend.moreProjects?.(game).then((l) => { if (live) setList(l); }).catch(() => { if (live) setList([]); });
    return () => { live = false; };
  }, [game]);
  // Projects that are already in the catalog (installable or not) are listed above.
  const shown = useMemo(() => {
    const repos = new Set(known.flatMap((c) => [c.github, c.url, ...(c.urls ?? [])]).filter((u): u is string => !!u).map((u) => u.toLowerCase().replace(/^https:\/\/github\.com\//, '').replace(/\/+$/, '')));
    // Openplanet entries only on Openplanet games (moreprojects.rs filters too).
    const op = opGame(game);
    return (list ?? []).filter((p) => (!p.repo || !repos.has(p.repo.toLowerCase())) && (op || (p.kind !== 'openplanet-plugin' && !p.link.includes('openplanet.dev'))));
  }, [list, known, game]);
  if (!shown.length) return null;
  const toggle = () => { setOpen(!open); savePref('tmhub.moreProjects', open ? 'closed' : 'open'); };
  const opList = opCatalog ?? [];
  return (
    <div className="gm-moreproj">
      <button className="gm-sub gm-toggle" aria-expanded={open} onClick={toggle}>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />} {t('gm.moreProjects')} <span className="dim">{shown.length}</span>
      </button>
      {open && (
        <div className="gm-list">
          {shown.map((p) => (
            <div key={p.link} className="gm-row" role="button" tabIndex={0} title={p.link}
              onClick={() => backend.openExternal(p.link)} onKeyDown={(e) => { if (e.key === 'Enter') backend.openExternal(p.link); }}>
              <span className="grow min0">
                <b className="ellip">{p.name}</b>
                {p.summary && <span className="dim small ellip">{p.summary}</span>}
              </span>
              <span className="pill tiny muted">{/openplanet\.dev/.test(p.link) ? 'Openplanet' : 'GitHub'}</span>
              {(() => { const op = opGame(game) ? matchOpPlugin(p, opList) : null; return op ? <span onClick={(e) => e.stopPropagation()}><OpPluginActions p={op} /></span> : null; })()}
              <ExternalLink size={14} className="dim" />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Where an install was found (scan.rs source labels, English) -> plain words and a tooltip. */
const SOURCE_TEXT: Record<string, [string | null, string]> = {
  Installer: ['inst.src.installer', 'inst.src.installerTip'],
  Steam: [null, 'inst.src.steamTip'],
  'Ubisoft Connect': [null, 'inst.src.ubiTip'],
  'Epic Games': [null, 'inst.src.epicTip'],
  'Installed program': ['inst.src.program', 'inst.src.programTip'],
  'Found on drive': ['inst.src.drive', 'inst.src.driveTip'],
  'Added folder': ['inst.src.added', 'inst.src.addedTip'],
  'Unofficial 1.80 patch': ['inst.src.patch', 'inst.src.patchTip'],
  'Games folder': ['inst.src.games', 'inst.src.gamesTip'],
  'Original (StarForce)': [null, 'inst.src.starforceTip'],
  Instance: ['inst.src.instance', 'inst.src.instanceTip'],
};
export function sourceText(source: string, t: (k: string) => string): { label: string; tip: string | null } {
  const e = SOURCE_TEXT[source];
  return e ? { label: e[0] ? t(e[0]) : source, tip: t(e[1]) } : { label: source, tip: null };
}

/** Every folder found for the game: Play starts it, "Make default" makes the big Play button use it. */
export function InstallationsCard({ g }: { g: GameView }) {
  const hub = useHubState();
  const t = useT();
  const found = installsOf(hub.snapshot, g.id);
  const all = found.length ? found : g.install ? [{ ...g.install }] : [];
  const norm = (p: string) => p.replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase();
  // "Hide" per folder, remembered on this PC (the folder stays on disk and can be shown again).
  const [hidden, setHidden] = useState<string[]>(() => { try { return JSON.parse(loadPref('tmhub.hiddenInstalls') || '[]'); } catch { return []; } });
  const [showHidden, setShowHidden] = useState(false);
  const isHidden = (p: string) => hidden.includes(norm(p));
  const toggleHide = (p: string) => { const n = isHidden(p) ? hidden.filter((h) => h !== norm(p)) : [...hidden, norm(p)]; setHidden(n); savePref('tmhub.hiddenInstalls', JSON.stringify(n)); };
  const nHidden = all.filter((i) => isHidden(i.path)).length;
  const list = all.filter((i) => showHidden || !isHidden(i.path));
  const [cur, set] = useSelectedInstall(g.id, all.filter((i) => !isHidden(i.path)).map((i) => i.path));
  const extra = backend.info?.()?.settings.extraFolders ?? [];
  const own = (p: string) => extra.find((e) => norm(p).startsWith(norm(e)));
  if (!list.length && !isNative) return null;
  return (
    <section className="panel installs-card">
      <SectionHead title={t('gm.installs')} sub={list.length > 1 ? t('gm.installsN', { n: list.length }) : undefined} />
      {list.length === 0 && <p className="dim small">{t('gm.noInstalls')}</p>}
      <div className="inst-list">
        {list.map((i) => {
          const on = list.length === 1 || norm(i.path) === norm(cur);
          const mine = own(i.path);
          const src = sourceText(i.source, t);
          return (
            <div className={'inst-row' + (on ? ' on' : '')} key={i.path}>
              <div className="grow min0">
                <b className="inst-name" title={i.path}><span className="ellip">{folderName(i.path)}</span>{on && list.length > 1 && <span className="pill tiny muted inst-default" title={t('gm.defaultTip')}>{t('gm.default')}</span>}</b>
                <span className="dim small ellip" title={[src.tip, i.path].filter(Boolean).join('\n')}>{[src.label, i.exe ? folderName(i.exe) : null].filter(Boolean).join(' · ')}</span>
              </div>
              <div className="inst-actions">
                {!on && <button className="btn ghost sm" onClick={() => set(i.path)} title={t('gm.setDefaultTip')}>{t('gm.setDefault')}</button>}
                <button className="btn primary sm" disabled={!!hub.launching[g.id] && hub.launching[g.id] !== 'running'} title={t('gm.playHereTip')}
                  onClick={() => void hub.play(g.id, null, false, list.length > 1 ? i.path : null)}>{hub.launching[g.id] && hub.launching[g.id] !== 'running' ? <Loader2 size={13} className="spin" /> : <Play size={13} fill="currentColor" />} {t('gm.playHere')}</button>
                {all.length > 1 && <button className="btn icon tiny" title={isHidden(i.path) ? t('gm.unhide') : t('gm.hide')} aria-label={isHidden(i.path) ? t('gm.unhide') : t('gm.hide')} onClick={() => toggleHide(i.path)}><EyeOff size={14} /></button>}
                {isNative && <button className="btn icon tiny" title={t('common.openFolder')} aria-label={t('common.openFolder')} onClick={() => backend.reveal?.(i.path).then((r) => { if (!r.ok) hub.toast(r); })}><FolderOpen size={14} /></button>}
                {isNative && mine && backend.removeFolder && <button className="btn icon tiny" title={t('gm.removeFolderTip')} aria-label={t('common.remove')} onClick={async () => { await backend.removeFolder!(mine); await backend.rescan(); }}><Trash2 size={14} /></button>}
              </div>
            </div>
          );
        })}
      </div>
      {nHidden > 0 && <button className="btn ghost sm" onClick={() => setShowHidden((v) => !v)}>{showHidden ? t('gm.hideHidden') : t('gm.showHidden', { n: nHidden })}</button>}
      {isNative && backend.addFolder && (
        <button className="btn ghost sm" onClick={async () => {
          const r = await backend.addFolder!();
          if (r.message !== 'Cancelled') hub.toast({ ok: r.added, message: r.added ? t('library.addedGame', { games: (r.games ?? []).join(', ') }) : (r.message ?? t('library.noGameThere')) });
        }}><FolderPlus size={14} /> {t('gm.addFolder')}</button>
      )}
    </section>
  );
}
