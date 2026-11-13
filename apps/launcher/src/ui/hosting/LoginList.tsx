import { useEffect, useMemo, useRef, useState } from 'react';
import { History, X } from 'lucide-react';
import { isValidLogin, splitLogins } from '../../data/logins.ts';
import type { SeenPlayer } from '../../data/hosting';
import { useT } from '../../i18n';
import { TmRich } from './TmPreview';

/** "5 min ago" in the page language. */
export function ago(unix: number): string {
  const lang = document.documentElement.lang || 'en';
  const s = Math.max(0, Date.now() / 1000 - unix);
  const f = new Intl.RelativeTimeFormat(lang, { numeric: 'auto' });
  if (s < 3600) return f.format(-Math.max(1, Math.round(s / 60)), 'minute');
  if (s < 86400) return f.format(-Math.round(s / 3600), 'hour');
  return f.format(-Math.round(s / 86400), 'day');
}

export function LoginList({ title, hint, items, onChange, placeholder, max, seen }: {
  title: string; hint?: string; items: string[]; onChange: (items: string[]) => void; placeholder?: string; max?: number;
  /** Players seen on this server: offered by "From recent players", their last nickname shown next to a login. */
  seen?: SeenPlayer[];
}) {
  const t = useT();
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [sure, setSure] = useState(false);
  const [recent, setRecent] = useState(false);
  const [rq, setRq] = useState('');
  const box = useRef<HTMLDivElement>(null);
  const nickOf = useMemo(() => new Map((seen ?? []).map((p) => [p.login.toLowerCase(), p.nick])), [seen]);
  const offer = (seen ?? []).filter((p) => !items.some((x) => x.toLowerCase() === p.login.toLowerCase()) && (!rq || (p.login + ' ' + p.nick).toLowerCase().includes(rq.toLowerCase())));
  useEffect(() => {
    if (!recent) return;
    const close = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setRecent(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [recent]);

  const add = (raw: string) => {
    const parts = splitLogins(raw);
    if (!parts.length) return;
    const bad = parts.filter((p) => !isValidLogin(p));
    if (bad.length) { setError(t('hostlist.invalid', { login: bad[0] })); return; }
    const next = [...items];
    const seen = new Set(next.map((x) => x.toLowerCase()));
    for (const p of parts) {
      if (seen.has(p.toLowerCase())) continue;
      if (max !== undefined && next.length >= max) { setError(t('hostlist.max', { n: max })); onChange(next); setDraft(''); return; }
      seen.add(p.toLowerCase());
      next.push(p);
    }
    setError('');
    setDraft('');
    onChange(next);
  };

  return (
    <div className="hs-list">
      <div className="hs-list-head">
        <b>{title}</b>
        <span className="dim">{items.length}{max !== undefined ? ` / ${max}` : ''}</span>
        {items.length > 0 && (
          <button type="button" className="btn ghost hs-list-clear" onClick={() => { if (sure) { setSure(false); onChange([]); } else setSure(true); }} onBlur={() => setSure(false)}>
            {sure ? t('hostlist.sure') : t('hostlist.clear')}
          </button>
        )}
      </div>
      {hint && <div className="dim hs-list-hint">{hint}</div>}
      <div className="hs-list-add">
        <input
          className="text-in hs-list-input"
          value={draft}
          placeholder={placeholder}
          spellCheck={false}
          onChange={(e) => { setDraft(e.target.value); if (error) setError(''); }}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(draft); } }}
          onPaste={(e) => {
            const text = e.clipboardData.getData('text');
            if (splitLogins(text).length > 1) { e.preventDefault(); add(text); }
          }}
        />
        <button type="button" className="btn ghost" onClick={() => add(draft)} disabled={!draft.trim()}>{t('hostlist.add')}</button>
        {seen && (
          <div className="hs-recent" ref={box}>
            <button type="button" className="btn ghost" aria-expanded={recent} aria-haspopup="listbox" onClick={() => setRecent(!recent)} title={t('hostlist.recentHint')}>
              <History size={14} />{t('hostlist.recent')}
            </button>
            {recent && (
              <div className="hs-recent-pop" role="dialog" aria-label={t('hostlist.recent')} onKeyDown={(e) => { if (e.key === 'Escape') setRecent(false); }}>
                <input className="text-in" autoFocus value={rq} onChange={(e) => setRq(e.target.value)} placeholder={t('hostlist.recentFilter')} aria-label={t('hostlist.recentFilter')} />
                <ul role="listbox">
                  {seen.length === 0 && <li className="dim small hs-recent-empty">{t('hostlist.recentNone')}</li>}
                  {seen.length > 0 && offer.length === 0 && <li className="dim small hs-recent-empty">{t('hostlist.recentAll')}</li>}
                  {offer.slice(0, 100).map((p) => (
                    <li key={p.login}>
                      <button type="button" role="option" aria-selected={false} onClick={() => add(p.login)}>
                        <span className="hs-recent-nick"><TmRich text={p.nick || p.login} /></span>
                        <span className="mono dim">{p.login}</span>
                        <span className="dim hs-recent-ago">{ago(p.lastSeen)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>
      {error && <div className="hs-error">{error}</div>}
      {items.length > 0 && (
        <div className="hs-list-items">
          {items.map((l) => (
            <span key={l} className="hs-login" title={nickOf.get(l.toLowerCase()) ? t('hostlist.lastNick') : undefined}>
              <span className="mono">{l}</span>
              {nickOf.get(l.toLowerCase()) && <span className="hs-login-nick"><TmRich text={nickOf.get(l.toLowerCase())!} /></span>}
              <button type="button" className="hs-login-x" title={t('hostlist.remove')} aria-label={t('hostlist.remove')} onClick={() => onChange(items.filter((x) => x !== l))}><X size={12} /></button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
