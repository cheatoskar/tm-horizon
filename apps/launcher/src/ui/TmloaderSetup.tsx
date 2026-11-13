// "TMLoader is needed for Forever mods": downloads the official installer from Tomashu's site and
// starts it after the user agreed (it is his installer and its own steps). When it closes, TM
// Horizon scans again and continues the mod install that was waiting for TMLoader.
import { useEffect, useState } from 'react';
import { AlertTriangle, Download, Loader2, RefreshCw } from 'lucide-react';
import { backend, isNative } from '../data/backend';
import { useHubState } from '../state';
import { useT } from '../i18n';
import { Modal } from './Modal';
import { LINUX_GUIDED, onLinux, openLinuxSetup } from './linuxOpen';

/** Mod whose install waits for TMLoader (continued once TMLoader is found). */
let pending: string | null = null;

type Phase = 'idle' | 'ask' | 'download' | 'running' | 'missing' | 'error';

export function TmloaderSetupCard({ modId, compact = false, onReady, game }: { modId?: string; compact?: boolean; onReady?: () => void; game?: string }) {
  const hub = useHubState();
  const t = useT();
  const [phase, setPhase] = useState<Phase>('idle');
  const [err, setErr] = useState<string | null>(null);
  const api = backend.tmloaderSetup;

  const found = async () => {
    await backend.rescan().catch(() => undefined);
    hub.toast({ ok: true, message: t('tmlsetup.done') });
    onReady?.();
    const m = pending;
    pending = null;
    if (m) hub.setDialog({ kind: 'install', modId: m });
  };

  useEffect(() => {
    if (!backend.on) return;
    return backend.on((e) => {
      if (e.type !== 'tmloaderSetupDone') return;
      if (e.installed) void found(); else setPhase('missing');
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (!isNative) return null;
  if (hub.snapshot.tmloader.installed) {
    // Installed in a Wine prefix but never started: its settings file appears at the first start.
    if (!hub.snapshot.tmloader.firstRun || compact) return null;
    return <div className="notice slim"><AlertTriangle size={16} /><div className="small grow">{t('tmlsetup.firstRun')}</div></div>;
  }
  // Linux: TMLoader goes into the game's Wine prefix through the guided setup.
  const linuxGame = game && LINUX_GUIDED.includes(game) ? game : hub.game('tmuf')?.installed || !hub.game('tmnf')?.installed ? 'tmuf' : 'tmnf';
  const linux = onLinux();

  const start = async () => {
    if (!api) return;
    if (modId) pending = modId;
    setErr(null);
    setPhase('download');
    try {
      const d = await api.download();
      setPhase('running');
      await api.run(d.path);
    } catch (e) { setErr(String(e)); setPhase('error'); }
  };
  const recheck = async () => {
    const s = await backend.rescan().catch(() => null);
    if (s?.tmloader.installed) void found(); else setPhase('missing');
  };

  return (
    <div className={'panel tml-setup' + (compact ? ' compact' : '')}>
      <div className="tml-setup-head"><AlertTriangle size={16} /> <b>{t('tmlsetup.title')}</b></div>
      {!compact && <p className="dim small">{t('tmlsetup.text')}</p>}
      {phase === 'running' && <p className="small"><Loader2 size={13} className="spin" /> {t('tmlsetup.running')}</p>}
      {phase === 'missing' && <p className="small warn">{t('tmlsetup.missing')}</p>}
      {phase === 'error' && err && <p className="small warn">{err}</p>}
      <div className="tml-setup-btns">
        {phase === 'download'
          ? <button className="btn primary sm" disabled><Loader2 size={14} className="spin" /> {t('tmlsetup.downloading')}</button>
          : linux
            ? <button className="btn primary sm" onClick={() => openLinuxSetup(linuxGame)}><Download size={14} /> {t('tmlsetup.linuxSetup')}</button>
            : phase !== 'running' && api && <button className="btn primary sm" onClick={() => setPhase('ask')}><Download size={14} /> {t('tmlsetup.install')}</button>}
        {(phase === 'running' || phase === 'missing') && <button className="btn ghost sm" onClick={recheck}><RefreshCw size={14} /> {t('tmlsetup.check')}</button>}
        <button className="btn ghost sm" onClick={() => backend.openExternal('https://tomashu.dev/software/tmloader/')}>{t('tmlsetup.page')}</button>
      </div>
      {phase === 'ask' && (
        <Modal title={t('tmlsetup.askTitle')} onClose={() => setPhase('idle')}
          actions={<><button className="btn ghost" onClick={() => setPhase('idle')}>{t('common.cancel')}</button><button className="btn primary" onClick={start}><Download size={15} /> {t('tmlsetup.go')}</button></>}>
          <p className="small">{t('tmlsetup.askText')}</p>
          <p className="dim small">{t('tmlsetup.askNote')}</p>
        </Modal>
      )}
    </div>
  );
}
