// Mod pages for entries that are not TMLoader products: catalog mods (GitHub releases, community posts,
// the ESWC proxy-DLL mods, the Openplanet loader) and Openplanet plugins. Every card in the Mods list
// opens one of these; install actions are the same as on the card (file install with confirmation,
// ESWC dialog with backup, Openplanet's official installer).
import { goBack, canGoBack } from '../data/navHistory';
import { useEffect, useState } from 'react';
import { ArrowLeft, Boxes, Download, ExternalLink, MessageCircle, Users } from 'lucide-react';
import { backend, isNative, type ProxyScan } from '../data/backend';
import { communitiesFile } from '../data/hub';
import { go, useHubState } from '../state';
import { GameChip, SectionHead } from '../ui/common';
import { CatalogInstallDialog } from '../ui/CatalogInstall';
import { EswcMods } from '../ui/EswcMods';
import { OpenplanetCard } from '../ui/OpenplanetSetup';
import { ReadmeView, ReleasesList, useReleases } from './ModDoc';
import { CatalogIcon, ESWC_PROXY_IDS, OPENPLANET_ID, OpCard, OpInstalledPlugins, SrcBadge, catalogSrc, opGameOf, useOpPlugins, type CatalogMod } from './ModSources';
import { useT } from '../i18n';
import { RelatedSection } from '../ui/Related';
import { companionOf, relatedLinksOf } from '../data/links';
import { ModShowcase, clickInstall } from '../ui/ModShowcase';
import { showcaseFor } from '../data/showcase';
import { HubClaimPanel } from '../ui/HubAccount';

/** GitHub repository of a catalog entry (its github field, or a github.com link). */
export function catalogRepo(c: Pick<CatalogMod, 'github' | 'url' | 'urls'>): string | undefined {
  if (c.github) return 'https://github.com/' + c.github.replace(/^\/+|\/+$/g, '');
  for (const u of [c.url, ...(c.urls ?? [])]) {
    const m = u && /^https:\/\/github\.com\/([^/\s]+)\/([^/\s#?]+)/i.exec(u);
    if (m) return `https://github.com/${m[1]}/${m[2]}`;
  }
  return undefined;
}

/** ESWC proxy-DLL install (ESWC Autosave) from its mod page: the same dialog as on the ESWC page. */
function EswcInstall({ modId }: { modId: string }) {
  const hub = useHubState();
  const t = useT();
  const g = hub.games.find((x) => x.id === 'tmn-eswc');
  const [scan, setScan] = useState<ProxyScan | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => { if (g?.installed && backend.proxyMods) backend.proxyMods('tmn-eswc').then(setScan).catch(() => setScan(null)); }, [g?.installed, n]);
  if (!isNative) return <p className="dim small">{t('op.onlyApp')}</p>;
  if (!g?.installed) return <p className="dim small">{t('catpage.eswcMissing')}</p>;
  return <EswcMods scan={scan} reload={() => setN((x) => x + 1)} only={modId === 'mod-eswc-autosave' ? 'ESWC Autosave' : undefined} />;
}

export function CatalogModPage({ c, autoInstall = false }: { c: CatalogMod; autoInstall?: boolean }) {
  const t = useT();
  const hub = useHubState();
  const spec = isNative && backend.catalogMods ? c.installSpec ?? null : null;
  const [dlg, setDlg] = useState(autoInstall && !!spec);
  const repo = catalogRepo(c);
  const releases = useReleases(repo);
  const [tab, setTab] = useState<'about' | 'versions'>('about');
  const url = c.url ?? c.urls?.[0] ?? null;
  const discord = !url && c.community ? communitiesFile.communities.find((x) => x.id === 'dir:tm-modding-community') : undefined;
  // ESWC Autosave's own ESWC dialog, unless the hub gives its loader (Legacy Essentials) as a normal install with the copy picker.
  const eswc = ESWC_PROXY_IDS.has(c.id) && !(spec?.starForceBlocked?.length);
  const isOp = c.id === OPENPLANET_ID;
  const opGames = isOp ? ['tm2020', ...(hub.games.some((g) => g.id.startsWith('tm2-') && g.installed) ? [hub.games.find((g) => g.id.startsWith('tm2-') && g.installed)!.id] : ['tm2-stadium'])] : [];
  const hint = c.install && c.install !== 'manual' ? c.install : null;
  return (
    <div className="page wide detail">
      <button className="back inline" onClick={() => goBack(() => go('mods'))}><ArrowLeft size={16} /> {canGoBack() ? t('common.back') : t('nav.mods')}</button>
      <div className="detail-head panel">
        <CatalogIcon c={c} size={104} />
        <div className="detail-title">
          <h1>{c.name}</h1>
          <p className="dim clamp2">{c.description}</p>
          <div className="detail-stats">
            {(c.author ?? c.maintainer) && <span>{c.author ?? c.maintainer}</span>}
            <SrcBadge src={catalogSrc(c)} />
            {c.modType && <span className="cat">{c.modType}</span>}
          </div>
        </div>
        <div className="detail-actions">
          {spec && <button className="btn primary" onClick={() => setDlg(true)} title={spec.note ?? t('catinst.tip')}><Download size={15} /> {t('common.install')}</button>}
          {url && <button className="btn ghost" onClick={() => backend.openExternal(url)} title={url}><ExternalLink size={15} /> {spec || eswc || isOp ? t('mods.openLink') : t('mods.openPage')}</button>}
          {discord && <button className="btn ghost" onClick={() => backend.openExternal(discord.url)}><MessageCircle size={15} /> {t('mods.openDiscord')}</button>}
          {!url && c.community && <button className="btn ghost" onClick={() => go('community')}><Users size={15} /> {t('mods.communityPage')}</button>}
        </div>
      </div>

      {(() => {
        const sc = showcaseFor(c.id, c.name);
        return sc ? <ModShowcase showcase={sc} onInstall={spec ? clickInstall : undefined} companion={companionOf(relatedLinksOf(c.id, c.name))}
          releases={(releases ?? []).slice(0, 3).map((r) => ({ version: r.tag, notes: r.notes, date: r.date }))} /> : null;
      })()}

      <RelatedSection links={relatedLinksOf(c.id, c.name)} />

      {(eswc || isOp) && (
        <section className="panel">
          <SectionHead title={t('catpage.install')} />
          {eswc && <EswcInstall modId={c.id} />}
          {isOp && opGames.map((g) => (
            <div key={g} className="op-game-row">
              <GameChip id={g} />
              <OpenplanetCard game={g} compact />
            </div>
          ))}
        </section>
      )}

      {repo && (
        <div className="detail-tabs">
          <div className="tabs">
            <button className={tab === 'about' ? 'on' : ''} onClick={() => setTab('about')}>{t('mods.tabDescription')}</button>
            <button className={tab === 'versions' ? 'on' : ''} onClick={() => setTab('versions')}>{t('mods.tabVersions')} <span className="dim">{releases?.length ?? 0}</span></button>
          </div>
        </div>
      )}

      <div className="detail-grid">
        <div className="col">
          {repo && tab === 'about' && <ReadmeView repo={repo} fallback={c.description ?? ""} title={c.name} />}
          {repo && tab === 'versions' && <section className="panel"><ReleasesList list={releases} /></section>}
          {!repo && (
            <section className="panel">
              <p className="lead">{c.description ?? ""}</p>
              {c.downloadNote && <p className="dim small">{c.downloadNote}</p>}
              {!url && c.community && <p className="dim small">{t('mods.discordOnly')}</p>}
            </section>
          )}
        </div>
        <div className="col side">
          <section className="panel">
            <SectionHead title={t('mods.compat')} />
            <div className="side-block"><span className="dim small">{t('mods.games')}</span><div className="modcard-tags">{c.games.map((g) => <GameChip key={g} id={g} />)}</div></div>
            {hint && <div className="side-block"><span className="dim small">{t('mods.installedVia')}</span><div className="small">{hint}</div></div>}
            {eswc && <div className="side-block"><span className="cat"><Boxes size={12} /> {t('mods.installProxy', { dll: 'dinput8.dll', exe: 'TmNationsESWC.exe' })}</span></div>}
            {(c.requires ?? []).length > 0 && <div className="side-block"><span className="dim small">{t('catpage.requires')}</span><ul className="deps">{c.requires!.map((r) => <li key={r}>{r}</li>)}</ul></div>}
          </section>
          {spec?.note && <section className="panel"><p className="dim small">{spec.note}</p></section>}
          {!__RELEASE_PREVIEW__ && <HubClaimPanel entryId={c.id} />}
        </div>
      </div>
      {dlg && spec && <CatalogInstallDialog entry={c} spec={spec} onClose={() => setDlg(false)} />}
    </div>
  );
}

/** Page of one Openplanet plugin: the card, Openplanet's own status for its game, installed plugins. */
export function OpPluginPage({ id }: { id: number }) {
  const t = useT();
  const all = useOpPlugins(true);
  const p = all?.find((x) => x.id === id);
  return (
    <div className="page wide detail">
      <button className="back inline" onClick={() => goBack(() => go('mods'))}><ArrowLeft size={16} /> {canGoBack() ? t('common.back') : t('nav.mods')}</button>
      {!all && <p className="dim">{t('moddetail.loading')}</p>}
      {all && !p && <p>{t('mods.notFound')}</p>}
      {p && (
        <>
          <h1>{p.name}</h1>
          <div className="modlist"><OpCard p={p} page /></div>
          <div className="detail-grid">
            <div className="col">
              <section className="panel">
                <p className="lead">{p.short}</p>
                <button className="btn ghost sm" onClick={() => backend.openExternal(p.page)}><ExternalLink size={14} /> {t('catpage.opPage')}</button>
              </section>
            </div>
            <div className="col side">
              <OpenplanetCard game={opGameOf(p)} />
              <section className="panel">
                <SectionHead title={t('game.opPlugins')} />
                <OpInstalledPlugins game={opGameOf(p)} compact />
              </section>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
