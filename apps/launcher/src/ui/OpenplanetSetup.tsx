// Openplanet for Trackmania (2020) and ManiaPlanet: shows whether it is installed (Openplanet.dll in the
// game folder, version read from it), the newest version on openplanet.dev, and installs or updates it
// with the official installer from openplanet.dev after the user agreed. The installer shows its own
// steps; TM Horizon only fills in the game folder. Nothing is bundled or mirrored.
import { useEffect, useState } from 'react';
import { AlertTriangle, ArrowUpCircle, CheckCircle2, Download, ExternalLink, Loader2, RefreshCw } from 'lucide-react';
import { backend, isNative, type OpStatus } from '../data/backend';
import { useHubState } from '../state';
import { useT } from '../i18n';
import { Modal } from './Modal';

type Phase = 'idle' | 'ask' | 'download' | 'running' | 'missing' | 'error';

const PAGE = 'https://openplanet.dev/download';

/** Openplanet status for a game (null while loading or outside the app). `n` reloads. */
export function useOpStatus(game: string, online = true): [OpStatus | null, () => void] {
  const [s, setS] = useState<OpStatus | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    backend.openplanet?.status?.(game, online).then((x) => { if (live) setS(x); }).catch(() => { if (live) setS(null); });
    return () => { live = false; };
  }, [game, online, n]);
  useEffect(() => backend.on?.((e) => { if (e.type === 'openplanetSetupDone') setN((x) => x + 1); }), []);
  return [s, () => setN((x) => x + 1)];
}

/** Several cards of the same game can be open at once (plugin card + Openplanet card): one toast per finished setup. */
let lastDoneToast = { key: '', at: 0 };
const firstToastFor = (key: string) => {
  const now = Date.now();
  if (lastDoneToast.key === key && now - lastDoneToast.at < 10_000) return false;
  lastDoneToast = { key, at: now };
  return true;
};

/** Install / update flow; `onDone` runs once Openplanet is found after the installer closed. */
export function useOpSetup(game: string, onDone?: () => void) {
  const hub = useHubState();
  const t = useT();
  const [phase, setPhase] = useState<Phase>('idle');
  const [err, setErr] = useState<string | null>(null);
  const api = backend.openplanet;
  useEffect(() => backend.on?.((e) => {
    if (e.type !== 'openplanetSetupDone' || e.game !== game) return;
    if (e.installed) {
      setPhase('idle');
      if (firstToastFor(`${e.game}|${e.version ?? ''}`)) { hub.toast({ ok: true, message: t('opsetup.done', { v: e.version ?? '' }) }); void backend.rescan().catch(() => undefined); }
      onDone?.();
    }
    else setPhase('missing');
  }), [game]); // eslint-disable-line react-hooks/exhaustive-deps
  const start = async () => {
    if (!api?.setupDownload || !api.setupRun) return;
    setErr(null);
    setPhase('download');
    try {
      const d = await api.setupDownload(game);
      setPhase('running');
      await api.setupRun(game, d.path);
    } catch (e) { setErr(String(e)); setPhase('error'); }
  };
  return { phase, setPhase, err, start, can: !!api?.setupDownload };
}

/** The consent dialog: what happens, where it comes from. */
export function OpSetupAsk({ update, version, onGo, onClose }: { update: boolean; version?: string | null; onGo: () => void; onClose: () => void }) {
  const t = useT();
  return (
    <Modal title={update ? t('opsetup.askUpdate', { v: version ?? '' }) : t('opsetup.askTitle')} onClose={onClose}
      actions={<><button className="btn ghost" onClick={onClose}>{t('common.cancel')}</button><button className="btn primary" onClick={onGo}><Download size={15} /> {t('opsetup.go')}</button></>}>
      <p className="small">{t('opsetup.askText')}</p>
      <p className="dim small">{t('opsetup.askNote')}</p>
    </Modal>
  );
}

/** Card on the TM2020 / ManiaPlanet pages and on plugin pages: status, version, install or update. */
export function OpenplanetCard({ game, compact = false, onReady }: { game: string; compact?: boolean; onReady?: () => void }) {
  const t = useT();
  const [s, reload] = useOpStatus(game);
  const setup = useOpSetup(game, () => { reload(); onReady?.(); });
  if (!isNative || !backend.openplanet?.status) return null;
  if (!s) return null;
  const { phase, setPhase, err, start } = setup;
  const recheck = () => { reload(); setPhase('idle'); };
  return (
    <div className={'panel op-setup' + (compact ? ' compact' : '') + (s.installed ? ' ok' : '')}>
      <div className="tml-setup-head">
        {s.installed ? <CheckCircle2 size={16} className="good" /> : <AlertTriangle size={16} />}
        <b>{s.installed ? t('opsetup.found', { v: s.version ?? t('opsetup.unknownVer') }) : t('opsetup.title')}</b>
        {s.installed && s.branch && s.branch !== 'next' && <span className="pill tiny">{s.branch}</span>}
        {s.update && s.latest && <span className="pill tiny warn-pill">{t('updates.available', { v: s.latest.version })}</span>}
      </div>
      {!compact && !s.installed && <p className="dim small">{t('opsetup.text')}</p>}
      {!compact && s.installed && !s.dllFound && <p className="dim small">{t('opsetup.userOnly', { dir: s.userDir })}</p>}
      {!s.gameDir && !s.installed && <p className="dim small">{t('opsetup.noGame')}</p>}
      {phase === 'running' && <p className="small"><Loader2 size={13} className="spin" /> {t('opsetup.running')}</p>}
      {phase === 'missing' && <p className="small warn">{t('opsetup.missing')}</p>}
      {phase === 'error' && err && <p className="small warn">{err}</p>}
      <div className="tml-setup-btns">
        {phase === 'download'
          ? <button className="btn primary sm" disabled><Loader2 size={14} className="spin" /> {t('opsetup.downloading')}</button>
          : phase !== 'running' && setup.can && (!s.installed || s.update) && (
            <button className="btn primary sm" onClick={() => setPhase('ask')}>{s.update ? <ArrowUpCircle size={14} /> : <Download size={14} />} {s.update ? t('common.update') : t('opsetup.install')}</button>
          )}
        {(phase === 'running' || phase === 'missing') && <button className="btn ghost sm" onClick={recheck}><RefreshCw size={14} /> {t('opsetup.check')}</button>}
        <button className="btn ghost sm" onClick={() => backend.openExternal(PAGE)}><ExternalLink size={14} /> openplanet.dev</button>
      </div>
      {phase === 'ask' && <OpSetupAsk update={s.installed} version={s.latest?.version} onGo={start} onClose={() => setPhase('idle')} />}
    </div>
  );
}
