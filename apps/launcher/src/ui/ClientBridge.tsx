// Client bridge (Rust: src-tauri/src/clientbridge.rs): the Horizon Host in a running game asks to connect
// (TMX search in the game, record replays, notifications). The player answers here once per game install.
import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Gamepad2, Unlink } from 'lucide-react';
import { isTauri } from '../data/native';
import { useI18n, fmtDate } from '../i18n';

type Ask = { instance: string; game: string; gameName: string; client: string; version: string; first: number; last: number };
type Paired = { key: string; game: string; gameName: string; instance: string; at: number };
export type BridgeStatus = { port: number | null; asks: Ask[]; paired: Paired[] };

function useBridge(): [BridgeStatus | null, (s: BridgeStatus) => void] {
  const [st, setSt] = useState<BridgeStatus | null>(null);
  useEffect(() => {
    if (!isTauri()) return;
    let dead = false;
    let off: (() => void) | undefined;
    invoke<BridgeStatus>('client_bridge_status').then((s) => { if (!dead) setSt(s); }).catch(() => {});
    listen<BridgeStatus>('client-bridge', (e) => setSt(e.payload)).then((f) => { if (dead) f(); else off = f; });
    // asks expire after a few minutes without a new request: look again now and then
    const timer = window.setInterval(() => invoke<BridgeStatus>('client_bridge_status').then((s) => { if (!dead) setSt(s); }).catch(() => {}), 15000);
    return () => { dead = true; off?.(); window.clearInterval(timer); };
  }, []);
  return [st, setSt];
}

/** The question in the corner while a game waits for Allow. */
export function ClientBridgePrompt() {
  const { t } = useI18n();
  const [st, setSt] = useBridge();
  const ask = st?.asks[0];
  if (!ask) return null;
  const answer = async (allow: boolean) => {
    await invoke('client_bridge_answer', { instance: ask.instance, allow }).catch(() => {});
    setSt(await invoke<BridgeStatus>('client_bridge_status'));
  };
  return (
    <div className="cb-prompt" role="dialog" aria-live="polite">
      <Gamepad2 size={20} className="cb-icon" />
      <div className="grow">
        <b>{t('cb.askTitle', { game: ask.gameName || ask.game })}</b>
        <div className="dim small">{t('cb.askText')}</div>
      </div>
      <div className="cb-actions">
        <button className="btn primary sm" onClick={() => answer(true)}>{t('cb.allow')}</button>
        <button className="btn ghost sm" onClick={() => answer(false)}>{t('cb.deny')}</button>
      </div>
    </div>
  );
}

/** Settings: which games are connected, forget them. */
export function ClientBridgeSettings() {
  const { t } = useI18n();
  const [st, setSt] = useBridge();
  if (!isTauri()) return <p className="dim small">{t('tmxup.desktopOnly')}</p>;
  const forget = async (instance: string | null) => setSt(await invoke<BridgeStatus>('client_bridge_forget', { instance }));
  return (
    <div className="cb-settings">
      <p className="dim small">{st?.port ? t('cb.port', { port: String(st.port) }) : t('cb.noPort')}</p>
      {st && st.paired.length === 0 && <p className="dim small">{t('cb.none')}</p>}
      {st?.paired.map((p) => (
        <div className="pd-mod" key={p.instance}>
          <Gamepad2 size={16} />
          <span className="grow">{p.gameName || p.game} <span className="dim small">{fmtDate(p.at)}</span></span>
          <button className="btn ghost sm" onClick={() => forget(p.instance)}><Unlink size={14} /> {t('cb.forget')}</button>
        </div>
      ))}
      {st && st.paired.length > 1 && <button className="btn ghost sm" onClick={() => forget(null)}>{t('cb.forgetAll')}</button>}
    </div>
  );
}
