// Health check of one game: what is in order and what to do about the rest. Runs on request,
// changes nothing. Rust side: src-tauri/src/health.rs.
import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { AlertTriangle, Check, Info, Loader2, X, HeartPulse } from 'lucide-react';
import { backend, isNative } from '../data/backend';
import { DEFENDER_HISTORY } from '../state';
import { useT } from '../i18n';

interface Line { id: string; status: 'ok' | 'info' | 'warn' | 'fail'; detail: string; fix: string | null; key?: string | null; args?: Record<string, string>; fixKey?: string | null }

const ICON = { ok: Check, info: Info, warn: AlertTriangle, fail: X } as const;

export function HealthCheckCard({ game }: { game: string }) {
  const t = useT();
  const [lines, setLines] = useState<Line[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  if (!isNative) return null;
  const run = async () => {
    setBusy(true);
    setErr('');
    try { setLines(await invoke<Line[]>('health_check', { gameId: game })); } catch (e) { setErr(String(e)); }
    setBusy(false);
  };
  const bad = lines?.filter((l) => l.status === 'warn' || l.status === 'fail').length ?? 0;
  return (
    <section className="panel health-card">
      {/* Title with its status chip on the left, the button on the same row at the right. */}
      <div className="section-head health-head">
        <div className="health-title">
          <h2>{t('health.title')}</h2>
          {lines && <span className={'pill tiny ' + (bad ? 'warn' : 'ok')}>{bad ? t('health.problems', { n: bad }) : t('health.allGood')}</span>}
        </div>
        <button className="btn ghost sm nowrap" disabled={busy} onClick={run}>{busy ? <Loader2 size={14} className="spin" /> : <HeartPulse size={14} />} {lines ? t('health.again') : t('health.run')}</button>
      </div>
      {!lines && !err && <p className="dim small">{t('health.sub')}</p>}
      {err && <p className="small warn">{err}</p>}
      {lines && (
        <ul className="health-list">
          {lines.map((l) => {
            const Icon = ICON[l.status];
            return (
              <li key={l.id} className={'health-' + l.status}>
                <Icon size={15} />
                <div className="grow">
                  <b>{t('health.id.' + l.id)}</b> <span className="dim small">{l.key ? t(l.key, l.args) : l.detail}</span>
                  {l.fix && <div className="small">{l.fixKey ? t(l.fixKey) : l.fix}</div>}
                  {l.id === 'defender' && l.status === 'fail' && <button className="btn primary sm health-fix" onClick={() => void backend.openExternal(DEFENDER_HISTORY)}>{t('defender.open')}</button>}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
