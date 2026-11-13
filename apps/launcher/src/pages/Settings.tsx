import { useEffect, useState } from 'react';
import { CheckCircle2, ShieldCheck, FolderOpen, FolderPlus, HardDrive, Image as ImageIcon, Info, Languages, LayoutGrid, Link2, List, Loader2, LogOut, MessageSquare, Moon, Orbit, Palette, Rows3, Sparkles, Sun, RefreshCw, Trash2, Wand2, XCircle } from 'lucide-react';
import { setModuleIconSet, useModuleIconSet } from '../ui/moduleIcons';
import { LANGS, tn, tp, useI18n, useT } from '../i18n';
import { invoke } from '@tauri-apps/api/core';
import { ACCENTS, go, loadPref, savePref, useHubState, type Look } from '../state';
import { SectionHead, Toggle } from '../ui/common';
import { ServersSettings } from '../ui/LiveServers';
import { timeAgo } from '../data/model';
import { backend, isNative, type AppInfo } from '../data/backend';
import { hubSource } from '../data/hub';
import { UpdatePanel } from '../ui/Updater';
import { LinuxPanel } from '../ui/LinuxSettings';
import { HubSourceSetting } from '../ui/HubSourceSetting';
import { HubAccountBlock } from '../ui/HubAccount';
import { TmxUploadPanel } from '../ui/TmxUpload';
import { ClientBridgeSettings } from '../ui/ClientBridge';
import { BackupPanel } from '../ui/Backup';
import { GbxAssocSetting } from '../ui/GbxOpen';

const ISSUES = 'https://github.com/cheatoskar/tm-horizon/issues';

const THEMES: Look['theme'][] = ['dark', 'midnight', 'light'];
/** Game styles set the theme and the accent colour in one click. */
const GAME_STYLES: { id: string; theme: Look['theme']; accent: string }[] = [
  { id: 'stadium', theme: 'dark', accent: 'orange' },
  { id: 'eswc', theme: 'dark', accent: 'blue' },
  { id: 'tm2', theme: 'dark', accent: 'teal' },
];

export function Settings({ focus }: { focus?: string }) {
  const hub = useHubState();
  const s = hub.snapshot;
  const [info, setInfo] = useState<AppInfo | undefined>(() => backend.info?.());
  const refreshInfo = () => setInfo(backend.info?.());
  // A switch that could not be saved says so instead of silently staying where it was.
  const saveSwitch = async (patch: Parameters<NonNullable<typeof backend.saveSettings>>[0]) => {
    try { await backend.saveSettings!(patch); } catch (e) { hub.toast({ ok: false, message: t('settings.saveFailed', { error: String(e) }) }); }
    refreshInfo();
  };
  const [hubUrl, setHubUrl] = useState(info?.settings.hubUrl ?? '');
  const [updateUrl, setUpdateUrl] = useState(info?.settings.updateUrl ?? '');
  const { t, choice, setLang } = useI18n();
  const ds = hub.driveScan;
  const set = info?.settings;
  const protoOk = !!info?.protocolCommand && info.protocolCommand.toLowerCase() === info.protocolExpected.toLowerCase();
  const look = hub.look;
  const iconSet = useModuleIconSet();
  // Linked from the Maps page and the Horizon Client card: jump to the TMX upload block.
  useEffect(() => {
    if (focus === 'tmx-upload') document.getElementById('set-tmx-upload')?.scrollIntoView({ block: 'start' });
  }, [focus]);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{t('nav.settings')}</h1>
          <span className="dim">{isNative ? t('settings.nativeSub', { v: info?.version, platform: ({ windows: 'Windows', linux: 'Linux', macos: 'macOS' } as Record<string, string>)[info?.platform ?? ''] ?? info?.platform }) : t('settings.previewSub')}</span>
        </div>
        <div className="grow" />
      </div>

      <div className="settings-wrap">
        <div className="settings-block">
          <h2>{t('settings.appearance')}</h2>
          <section className="panel">
            <div className="setrow">
              {look.theme === 'light' ? <Sun size={18} /> : <Moon size={18} />}
              <div className="grow"><b>{t('settings.theme')}</b><div className="dim small setnote">{t('settings.themeNote')}</div></div>
              <div className="presets" role="radiogroup" aria-label={t('settings.theme')}>
                {THEMES.map((th) => (
                  <button key={th} role="radio" aria-checked={look.theme === th} className={'preset' + (look.theme === th ? ' on' : '')} onClick={() => hub.setLook({ theme: th })}>
                    <span className={'dot ' + th} />{t('settings.theme.' + th)}
                  </button>
                ))}
              </div>
            </div>
            <div className="setrow">
              <Sparkles size={18} />
              <div className="grow"><b>{t('settings.styles')}</b><div className="dim small setnote">{t('settings.stylesNote')}</div></div>
              <div className="presets" role="radiogroup" aria-label={t('settings.styles')}>
                {GAME_STYLES.map((p) => {
                  const on = look.theme === p.theme && look.accent === p.accent;
                  return (
                    <button key={p.id} role="radio" aria-checked={on} className={'preset' + (on ? ' on' : '')} onClick={() => hub.setLook({ theme: p.theme, accent: p.accent })}>
                      <span className={'dot ' + p.id} />{t('settings.style.' + p.id)}
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="setrow">
              <Palette size={18} />
              <div className="grow"><b>{t('settings.accent')}</b><div className="dim small setnote">{t('settings.accentNote')}</div></div>
              <div className="swatches" role="radiogroup" aria-label={t('settings.accent')}>
                {ACCENTS.filter((a) => a !== 'teal').map((a) => (
                  <button key={a} role="radio" aria-checked={look.accent === a} className={'swatch sw-' + a + (look.accent === a ? ' on' : '')}
                    title={t('accent.' + a)} aria-label={t('accent.' + a)} onClick={() => hub.setLook({ accent: a })} />
                ))}
              </div>
            </div>
            <div className="setrow">
              <Rows3 size={18} />
              <div className="grow"><b>{t('settings.compact')}</b><div className="dim small setnote">{t('settings.compactNote')}</div></div>
              <Toggle on={look.density === 'compact'} label={t('settings.compact')} onChange={() => hub.setLook({ density: look.density === 'compact' ? 'normal' : 'compact' })} />
            </div>
            <ImgCacheRow />
            <div className="setrow">
              <Orbit size={18} />
              <div className="grow"><b>{t('settings.moduleIcons')}</b><div className="dim small setnote">{t('settings.moduleIconsNote')}</div></div>
              <div className="seg small-seg" role="radiogroup" aria-label={t('settings.moduleIcons')}>
                {(['distinct', 'saturn'] as const).map((k) => <button key={k} role="radio" aria-checked={iconSet === k} className={iconSet === k ? 'on' : ''} onClick={() => setModuleIconSet(k)}>{t('settings.moduleIcons.' + k)}</button>)}
              </div>
            </div>
            <div className="setrow">
              <LayoutGrid size={18} />
              <div className="grow"><b>{t('settings.modsView')}</b><div className="dim small setnote">{t('settings.modsViewNote')}</div></div>
              <div className="presets" role="radiogroup" aria-label={t('settings.modsView')}>
                {(['tiles', 'list'] as const).map((v) => (
                  <button key={v} role="radio" aria-checked={look.modsView === v} className={'preset' + (look.modsView === v ? ' on' : '')} onClick={() => hub.setLook({ modsView: v })}>
                    {v === 'tiles' ? <LayoutGrid size={14} /> : <List size={14} />}{t(v === 'tiles' ? 'mods.layoutTiles' : 'mods.layoutList')}
                  </button>
                ))}
              </div>
            </div>
          </section>
        </div>

        {isNative && (
          <div className="settings-block">
            <h2>{t('wiz.title')}</h2>
            <section className="panel">
              <div className="setrow">
                <Wand2 size={18} />
                <div className="grow"><b>{t('wiz.title')}</b><div className="dim small setnote">{t('wiz.settingsNote')}</div></div>
                <button className="btn ghost sm" onClick={() => go('setup')}>{t('wiz.open')}</button>
              </div>
            </section>
          </div>
        )}

        <div className="settings-block">
          <h2>{t('settings.languageTitle')}</h2>
          <section className="panel">
            <div className="setrow">
              <Languages size={18} />
              <div className="grow"><b>{t('settings.languageLabel')}</b><div className="dim small setnote">{t('settings.languageNote')}</div></div>
              <select className="text-in" value={choice} onChange={(e) => setLang(e.target.value)} aria-label={t('settings.languageLabel')}>
                <option value="">{t('settings.languageSystem')}</option>
                {LANGS.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
              </select>
            </div>
          </section>
        </div>

        <div className="settings-block">
          <h2>{t('settings.folders')}</h2>
          <HomeStart />
          {!__RELEASE_PREVIEW__ && <HubSourceSetting />}
          {!__RELEASE_PREVIEW__ && <HubAccountBlock />}
          <section className="panel">
            <SectionHead title={t('settings.foldersTitle')} sub={t('settings.scanned', { ago: timeAgo(s.scannedAt) })} />
            <ul className="setlist">
              {s.steamLibraries.map((l) => (
                <li key={l.path}><span className="mono ellip" title={l.path}>{l.path}</span><span className="dim small">Steam · {l.exists ? tp('settings.games', l.appCount) : t('settings.missing')}</span></li>
              ))}
              <li><span className="mono">Ubisoft Connect</span><span className="dim small">{s.games.tm2020.installs.some((i) => i.source === 'Ubisoft Connect') ? 'Trackmania' : t('settings.nothing')}</span></li>
              <li><span className="mono">Epic Games</span><span className="dim small">{s.epic.length ? tp('settings.games', s.epic.length) : t('settings.nothing')}</span></li>
              {set?.extraFolders.map((f) => (
                <li key={f}><span className="mono ellip" title={f}>{f}</span><span className="dim small">{t('settings.added')}</span>
                  <button className="btn icon tiny" title={t('common.remove')} onClick={async () => { await backend.removeFolder!(f); refreshInfo(); }}><Trash2 size={13} /></button></li>
              ))}
              {set?.foundInstalls.map((f) => (
                <li key={f.path + f.game}><span className="mono ellip" title={f.path}>{f.path}</span><span className="dim small">{t('settings.found', { game: hub.game(f.game)?.short ?? f.game })}</span></li>
              ))}
            </ul>
            {isNative && (
              <div className="row-btns">
                <button className="btn ghost sm" title={t('library.scanTip')} onClick={() => backend.rescan().then(() => hub.toast({ message: t('library.scanned') }))}><RefreshCw size={14} /> {t('library.scan')}</button>
                {ds?.running
                  ? <button className="btn ghost sm" onClick={() => backend.cancelDriveScan!()}><XCircle size={14} /> {t('common.stop')}</button>
                  : <button className="btn ghost sm" title={t('library.scanDrivesTip')} onClick={() => backend.scanDrives!().then(() => hub.setDriveScan({ running: true }))}><HardDrive size={14} /> {t('library.scanDrives')}</button>}
                <button className="btn ghost sm" onClick={async () => {
                  const r = await backend.addFolder!();
                  hub.toast({ message: r.added ? t('settings.addedToast', { path: r.path }) : r.message ?? t('settings.nothingAdded'), ok: r.added || !r.message });
                  refreshInfo();
                }}><FolderPlus size={14} /> {t('settings.addFolder')}</button>
              </div>
            )}
            {ds && <p className="dim small ellip">{ds.running ? t('settings.scanning', { n: ds.dirs ?? 0, dir: ds.dir ?? '' }) : ds.result}</p>}
          </section>
        </div>

        {isNative && info && (
          <div className="settings-block">
            <h2>{t('settings.coversTitle')}</h2>
            <section className="panel">
              <div className="setrow">
                <ImageIcon size={18} />
                <div className="grow">
                  <b>{t('settings.coverDownloads')}</b>
                  <div className="dim small setnote">{t('settings.coverDownloadsNote')}</div>
                </div>
                <Toggle on={set?.coverDownloads !== false} label={t('settings.coverDownloads')}
                  onChange={() => saveSwitch({ coverDownloads: set?.coverDownloads === false })} />
              </div>
            </section>
          </div>
        )}

        {isNative && info && (
          <div className="settings-block">
            <h2>Discord</h2>
            <section className="panel">
              <div className="setrow">
                <MessageSquare size={18} />
                <div className="grow">
                  <b>{t('settings.discordShow')}</b>
                  <div className="dim small setnote">{info.discordAvailable ? t('settings.discordNote') : t('settings.discordSoon')}</div>
                </div>
                {/* Always switchable: with Discord closed it simply has no effect until Discord runs. */}
                <Toggle on={!!set?.discordPresence} label={t('settings.discordShow')}
                  onChange={() => saveSwitch({ discordPresence: !set?.discordPresence })} />
              </div>
              <div className="setrow">
                <MessageSquare size={18} />
                <div className="grow">
                  <b>{t('settings.discordTas')}</b>
                  <div className="dim small setnote">{t('settings.discordTasNote')}</div>
                </div>
                <span className={set?.discordPresence ? '' : 'is-off'}>
                  <Toggle on={set?.discordTas !== false} label={t('settings.discordTas')}
                    onChange={() => saveSwitch({ discordTas: set?.discordTas === false })} />
                </span>
              </div>
            </section>
          </div>
        )}

        <div className="settings-block" id="set-tmx-upload">
          <h2>{t('tmxup.title')}</h2>
          <TmxUploadPanel />
        </div>
        <div className="settings-block">
          <h2>{t('cb.title')}</h2>
          <ClientBridgeSettings />
        </div>
        <ServersSettings />

        {isNative && (
          <div className="settings-block">
            <h2>{t('backup.head')}</h2>
            <BackupPanel />
          </div>
        )}

        <LinuxPanel />

        <div className="settings-block">
          <h2>{t('settings.advanced')}</h2>
          <UpdatePanel />
          {isNative && info && (
            <section className="panel">
              <div className="setrow">
                <Link2 size={18} />
                <div className="grow"><b>{t('settings.protoTitle')}</b><div className="dim small setnote">{protoOk ? t('settings.protoOk') : info.protocolCommand ? t('settings.protoOther') : t('settings.protoNone')}</div></div>
                {protoOk
                  ? <button className="btn ghost sm" onClick={async () => { hub.toast(await backend.protocol!.unregister()); refreshInfo(); }}>{t('common.remove')}</button>
                  : <button className="btn ghost sm" onClick={async () => { hub.toast(await backend.protocol!.register()); refreshInfo(); }}>{t('settings.setUp')}</button>}
              </div>
              <GbxAssocSetting />
              <div className="setrow">
                <LogOut size={18} />
                <div className="grow"><b>{t('settings.embedded')}</b><div className="dim small setnote">{tn('settings.embeddedNote', { dir: <span className="mono">{info.embeddedProfile}</span> })}</div></div>
                <button className="btn ghost sm" onClick={() => hub.setConfirm({
                  title: t('settings.signOutTitle'), ok: t('settings.signOut'),
                  text: t('settings.signOutText'),
                  onOk: async () => { try { await backend.web!.clear(); hub.toast({ message: t('settings.signedOut') }); } catch (e) { hub.toast({ message: String(e), ok: false }); } },
                })}>{t('settings.signOut')}</button>
              </div>
              {!__RELEASE_PREVIEW__ && <>
              <div className="setrow">
                <div className="grow">
                  <b>{t('settings.hubUrl')}</b>
                  <div className="dim small setnote">{(hubSource === 'remote' ? t('settings.hubRemote') : t('settings.hubBundled')) + ' · ' + t('settings.hubNote')}</div>
                  <div className="setrow">
                    <input className="text-in mono grow" value={hubUrl} onChange={(e) => setHubUrl(e.target.value)} spellCheck={false} aria-label={t('settings.hubUrl')} />
                    <button className="btn ghost sm" onClick={async () => { await backend.saveSettings!({ hubUrl }); refreshInfo(); hub.toast({ message: t('settings.savedNextStart') }); }}>{t('common.save')}</button>
                  </div>
                </div>
              </div>
              <div className="setrow">
                <div className="grow">
                  <b>{t('settings.updateUrl')}</b>
                  <div className="dim small setnote">{t('settings.updateUrlNote')}</div>
                  <div className="setrow">
                    <input className="text-in mono grow" value={updateUrl} onChange={(e) => setUpdateUrl(e.target.value)} spellCheck={false} aria-label={t('settings.updateUrl')} />
                    <button className="btn ghost sm" onClick={async () => { await backend.saveSettings!({ updateUrl }); refreshInfo(); hub.toast({ message: t('settings.savedNextStart') }); }}>{t('common.save')}</button>
                  </div>
                </div>
              </div>
              </>}
              <div className="setrow">
                <FolderOpen size={18} />
                <div className="grow"><b>{t('settings.appData')}</b><div className="dim small setnote mono ellip" title={info.dataDir}>{info.dataDir}</div></div>
                <button className="btn ghost sm" onClick={() => backend.reveal!(info.dataDir)}>{t('common.open')}</button>
              </div>
            </section>
          )}
          <section className="panel">
            <SectionHead title={t('settings.sources')} sub={t('settings.sourcesSub')} right={isNative && <button className="btn ghost sm" title={t('settings.refreshSources')} onClick={() => backend.refreshIndex!()}><RefreshCw size={14} /></button>} />
            <ul className="setlist">
              {hub.index.servers.map((x) => (
                <li key={x.server}>
                  <span className="mono ellip" title={x.server}>{x.server}</span>
                  {x.ok ? <span className="small good"><CheckCircle2 size={13} /> {x.count}</span> : <span className="small warn" title={x.error}><XCircle size={13} /> {t('settings.failed')}</span>}
                </li>
              ))}
            </ul>
            <p className="dim small">{t('settings.checked', { ago: timeAgo(hub.index.fetchedAt) })}</p>
          </section>
          {/* About / credits: licence and where the official game covers come from. */}
          <section className="panel">
            <SectionHead title={t('settings.about')} />
            <div className="setrow">
              <Info size={18} />
              <div className="grow small">
                <div>TM Horizon {info?.version ?? ''} · {t('settings.aboutLicence')}</div>
                <div className="dim">{t('settings.coverCredit')}</div>
              </div>
            </div>
            {__RELEASE_PREVIEW__ && (
              <div className="setrow">
                <ShieldCheck size={18} />
                <div className="grow small">
                  <b>{t('about.privacyTitle')}</b>
                  <div className="dim setnote">{t('about.privacy')}</div>
                  <div className="dim setnote">{t('about.privacyHosts')}</div>
                </div>
              </div>
            )}
            <div className="setrow">
              <MessageSquare size={18} />
              <div className="grow small">
                <div className="dim">{t('about.trademark')}</div>
                <div className="dim">{t('about.contact')} <button className="linkish small" onClick={() => backend.openExternal(ISSUES)}>{ISSUES.replace('https://', '')}</button></div>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

/** Which game Home shows at start. (Play on Home always starts the game; its chevron shows the profile first.) */
function HomeStart() {
  const hub = useHubState();
  const { t } = useI18n();
  const info = backend.info?.().settings;
  const [def, setDef] = useState(() => info?.defaultGame ?? loadPref('tmhub.defaultGame'));
  const save = async (patch: { defaultGame?: string }) => {
    if (backend.saveSettings) await backend.saveSettings(patch);
    if (patch.defaultGame !== undefined) savePref('tmhub.defaultGame', patch.defaultGame);
  };
  return (
    <section className="panel">
      <div className="setrow">
        <div className="grow"><b>{t('settings.defaultGame')}</b><div className="dim small setnote">{t('settings.defaultGameNote')}</div></div>
        <select className="text-in" value={def} onChange={(e) => { setDef(e.target.value); save({ defaultGame: e.target.value }); }}>
          <option value="">{t('settings.defaultGameAuto')}</option>
          {hub.games.filter((g) => g.installed).map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
        </select>
      </div>
    </section>
  );
}

/** Picture cache (covers, thumbnails, site icons): size and a button to empty it. */
function ImgCacheRow() {
  const t = useT();
  const [info, setInfo] = useState<{ bytes: number; files: number; max: number } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (isNative) invoke<{ bytes: number; files: number; max: number }>('img_cache_info').then(setInfo).catch(() => setInfo(null)); }, []);
  if (!isNative) return null;
  const mb = (b: number) => `${(b / 1048576).toFixed(b < 10485760 ? 1 : 0)} MB`;
  return (
    <div className="setrow">
      <ImageIcon size={18} />
      <div className="grow"><b>{t('settings.imgCache')}</b><div className="dim small setnote">{info ? t('settings.imgCacheNote', { size: mb(info.bytes), n: info.files, max: mb(info.max) }) : '…'}</div></div>
      <button className="btn ghost sm" disabled={busy || !info?.files} onClick={async () => { setBusy(true); try { setInfo(await invoke('img_cache_clear')); } finally { setBusy(false); } }}>
        {busy ? <Loader2 size={14} className="spin" /> : <Trash2 size={14} />} {t('settings.imgCacheClear')}
      </button>
    </div>
  );
}
