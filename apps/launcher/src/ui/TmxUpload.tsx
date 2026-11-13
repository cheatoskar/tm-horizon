import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Upload } from 'lucide-react';
import { go, useHubState } from '../state';
import { isTauri } from '../data/native';
import { useI18n } from '../i18n';
import { Toggle } from './common';
import { Modal } from './Modal';

type Source = 'mod' | 'folder' | 'host' | 'manual';
export type UploadStatus = {
  games: { game: string; site: string; enabled: boolean; source: 'mod' | 'folder'; folder: string | null }[];
  confirmed: boolean;
  bridge: { state: 'off' | 'no-game' | 'pairing' | 'connected'; mod: string | null };
  handoverPort: number | null;
  /** Hosts that need a sign-in. */
  signin: string[];
  queue: { id: number; game: string; site: string; map: string; timeMs: number | null; source: Source; state: 'waiting' | 'uploading' | 'retry' | 'signin'; attempts: number; nextInSecs: number | null; detail: string | null }[];
  history: { at: number; game: string; site: string; map: string; timeMs: number | null; source: string; result: 'ok' | 'refused' | 'failed' | 'skipped'; detail: string; link: string | null }[];
};

/** m:ss.cc from milliseconds. */
const fmtTime = (ms: number | null) => {
  if (ms == null) return '';
  const cs = Math.floor(ms / 10) % 100;
  const s = Math.floor(ms / 1000) % 60;
  return `${Math.floor(ms / 60000)}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
};

/** One line on what the TMX auto-upload does, with a link to its settings (Maps page, Horizon Client card). */
export function TmxUploadLink({ className = '' }: { className?: string }) {
  const { t } = useI18n();
  return (
    <p className={'dim small tmxup-link ' + className}>
      <Upload size={13} /> {t('tmxup.linkText')} <button className="linkish small" onClick={() => go('settings', 'tmx-upload')}>{t('tmxup.linkOpen')}</button>
    </p>
  );
}

export function TmxUploadPanel() {
  const hub = useHubState();
  const { t } = useI18n();
  const [st, setSt] = useState<UploadStatus | null>(null);
  const [ask, setAsk] = useState<string | null>(null);
  const [pickGame, setPickGame] = useState('');
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!isTauri()) return;
    let off: (() => void) | undefined;
    let dead = false;
    invoke<UploadStatus>('tmx_upload_status').then((s) => {
      if (dead) return;
      setSt(s);
      // Sign-in state of the sites in use (one page load each, no upload).
      new Set(s.games.filter((g) => g.enabled).map((g) => g.site)).forEach((site) => { invoke('tmx_upload_check', { site }).catch(() => {}); });
    }).catch((e) => setErr(String(e)));
    listen<UploadStatus>('tmx-upload', (e) => setSt(e.payload)).then((f) => { if (dead) f(); else off = f; });
    return () => { dead = true; off?.(); };
  }, []);

  const run = useCallback(async (cmd: string, args: Record<string, unknown>) => {
    try { setErr(''); setSt(await invoke<UploadStatus>(cmd, args)); return true; }
    catch (e) { if (String(e) !== 'confirm') setErr(String(e)); return false; }
  }, []);

  if (!isTauri()) return <section className="panel"><p className="dim small">{t('tmxup.desktopOnly')}</p></section>;
  if (!st) return err ? <section className="panel"><p className="dim small">{err}</p></section> : null;

  const rows = st.games.filter((g) => hub.games.some((x) => x.id === g.game && x.installed));
  const shown = rows.length ? rows : st.games;
  const name = (id: string) => hub.games.find((g) => g.id === id)?.short ?? id;
  const defGame = pickGame || st.games.find((g) => g.enabled)?.game || 'tmnf';

  const toggle = async (g: UploadStatus['games'][number]) => {
    if (g.enabled) { await run('tmx_upload_set', { game: g.game, enabled: false, confirm: false }); return; }
    if (!st.confirmed) { setAsk(g.game); return; }
    await enable(g.game);
  };

  const enable = async (game: string) => {
    if (await run('tmx_upload_set', { game, enabled: true, confirm: true })) {
      const site = st.games.find((g) => g.game === game)?.site;
      if (site) invoke('tmx_upload_check', { site }).catch(() => {});
    }
  };

  const upload = async () => {
    const path = await invoke<string | null>('tmx_upload_pick').catch(() => null);
    if (path) await run('tmx_upload_file', { game: defGame, path });
  };

  /** Opens the site's login page in the launcher's embedded browser (same way as a deep link). */
  const signIn = (host: string) => {
    const g = st.games.find((x) => x.site === host)?.game ?? 'tmnf';
    hub.setPendingWeb({ mode: 'maps', game: g, url: `https://${host}/login` });
    go('maps', `${g}@${host}`);
  };

  const bridgeText = ({
    off: t('tmxup.bridge.off'), 'no-game': t('tmxup.bridge.noGame'), pairing: t('tmxup.bridge.pairing'),
    connected: t('tmxup.bridge.connected', { mod: st.bridge.mod ?? '' }),
  } as Record<string, string>)[st.bridge.state];
  const forever = shown.some((g) => g.game === 'tmnf' || g.game === 'tmuf');
  const qState = (q: UploadStatus['queue'][number]) => (q.state === 'retry' ? t('tmxup.q.retry', { n: q.nextInSecs ?? 0 }) : t('tmxup.q.' + q.state));

  return (
    <>
      <section className="panel">
        {shown.map((g) => (
          <div className="setrow" key={g.game}>
            <div className="grow">
              <b>{name(g.game)}</b>
              <div className="dim small setnote">{g.site} · {g.source === 'mod' ? t('tmxup.srcMod') : t('tmxup.srcFolder')}</div>
            </div>
            <span className="dim small">{t('tmxup.toggle')}</span>
            <Toggle on={g.enabled} label={t('tmxup.toggle') + ': ' + name(g.game)} onChange={() => toggle(g)} />
          </div>
        ))}
        <div className="setrow">
          <div className="grow">
            <b>{t('tmxup.bridge')}</b>
            <div className="dim small setnote">{bridgeText}{st.handoverPort ? ' · ' + t('tmxup.handover') : ''}</div>
          </div>
        </div>
        {st.signin.map((h) => (
          <div className="setrow" key={h}>
            <div className="grow dim small">{t('tmxup.notSignedIn', { host: h })}</div>
            <button className="btn ghost sm" onClick={() => signIn(h)}>{t('tmxup.signIn')}</button>
          </div>
        ))}
        {forever && <div className="setrow"><div className="grow dim small">{t('tmxup.patch')}</div></div>}
        <div className="setrow">
          <div className="grow" />
          <select className="text-in" value={defGame} onChange={(e) => setPickGame(e.target.value)} aria-label={t('tmxup.game')}>
            {st.games.map((g) => <option key={g.game} value={g.game}>{name(g.game)}</option>)}
          </select>
          <button className="btn ghost sm" onClick={upload}><Upload size={14} /> {t('tmxup.uploadFile')}</button>
        </div>
        {err && <p className="dim small">{err}</p>}
      </section>

      {st.queue.length > 0 && (
        <section className="panel">
          <ul className="setlist">
            {st.queue.map((q) => (
              <li key={q.id}>
                <span className="ellip" title={q.detail ?? undefined}>{q.map}{q.timeMs != null ? ' · ' + fmtTime(q.timeMs) : ''}</span>
                <span className="dim small">{qState(q)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {st.history.length > 0 && (
        <section className="panel">
          <table className="tmxup-table">
            <thead><tr><th>{t('tmxup.h.map')}</th><th>{t('tmxup.h.time')}</th><th>{t('tmxup.h.site')}</th><th>{t('tmxup.h.result')}</th><th /></tr></thead>
            <tbody>
              {st.history.slice(0, 20).map((h, i) => (
                <tr key={h.at + ':' + i} title={h.detail || undefined}>
                  <td className="ellip">{h.map}</td>
                  <td className="mono">{fmtTime(h.timeMs)}</td>
                  <td className="dim">{h.site}</td>
                  <td>{t('tmxup.r.' + h.result)}{h.result !== 'ok' && h.detail && <div className="dim small">{h.detail}</div>}</td>
                  <td>{h.link && <button className="btn ghost sm" onClick={() => invoke('open_external', { url: h.link })}>{t('common.open')}</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="row-btns"><button className="btn ghost sm" onClick={() => run('tmx_upload_clear', {})}>{t('tmxup.clear')}</button></div>
        </section>
      )}

      {ask && (
        <Modal title={t('tmxup.confirmTitle')} onClose={() => setAsk(null)}
          actions={<>
            <button className="btn ghost" onClick={() => setAsk(null)}>{t('common.cancel')}</button>
            <button className="btn primary" onClick={async () => { const g = ask; setAsk(null); await enable(g); }}>{t('tmxup.turnOn')}</button>
          </>}>
          <p>{t('tmxup.confirm1', { site: st.games.find((g) => g.game === ask)?.site ?? 'TMX' })}</p>
          <p>{t('tmxup.confirm2')}</p>
        </Modal>
      )}
    </>
  );
}
