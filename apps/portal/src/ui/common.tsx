import { Children, cloneElement, isValidElement, useCallback, useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyEvent, type ReactElement, type ReactNode } from 'react';
import { AlertCircle, AlertTriangle, Check, CheckCircle2, Copy, Info, RotateCw } from 'lucide-react';
import { ApiError } from '../api.ts';
import { initials } from '../labels.ts';

export const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e));

/** Loads data on mount and whenever deps change. */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [state, setState] = useState<{ data: T | null; error: unknown; loading: boolean }>({ data: null, error: null, loading: true });
  const run = useCallback(() => {
    let live = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    fn().then((data) => live && setState({ data, error: null, loading: false }), (error) => live && setState((s) => ({ data: s.data, error, loading: false })));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => run(), [run]);
  return { ...state, reload: run, setData: (d: T) => setState((s) => ({ ...s, data: d })) };
}

/** Runs an action with busy + error state. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async <T,>(f: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    setError(null);
    try { return await f(); } catch (e) { setError(errMsg(e)); return undefined; } finally { setBusy(false); }
  }, []);
  return { busy, error, setError, run };
}

export function Loading({ text = 'Loading' }: { text?: string }) {
  return (
    <div className="loading" role="status" aria-live="polite">
      <div className="loading-label"><span className="spinner" /> {text}</div>
      <div className="skel short" aria-hidden />
      <div className="skel" aria-hidden />
    </div>
  );
}

export function ErrorBox({ error, retry }: { error: unknown; retry?: () => void }) {
  if (!error) return null;
  return (
    <div className="errbox" role="alert">
      <span className="errbox-icon" aria-hidden><AlertCircle size={18} /></span>
      <div className="errbox-body">
        <span>{errMsg(error)}</span>
        {retry && <button className="btn sm" onClick={retry}><RotateCw size={14} /> Retry</button>}
      </div>
    </div>
  );
}

const NOTICE_ICON = { err: AlertCircle, ok: CheckCircle2, warn: AlertTriangle, info: Info } as const;

/** A .msg with an icon slot. Default icon follows the tone. */
export function Notice({ tone = 'info', icon, children }: { tone?: 'err' | 'ok' | 'warn' | 'info'; icon?: ReactNode; children: ReactNode }) {
  const I = NOTICE_ICON[tone];
  return (
    <div className={`msg has-icon ${tone}`} role={tone === 'err' ? 'alert' : undefined}>
      <span className="msg-icon" aria-hidden>{icon ?? <I size={16} />}</span>
      <div className="msg-body">{children}</div>
    </div>
  );
}

export function Async<T>({ r, children }: { r: ReturnType<typeof useAsync<T>>; children: (d: T) => ReactNode }) {
  if (r.data) return <>{r.error ? <ErrorBox error={r.error} retry={r.reload} /> : null}{children(r.data)}</>;
  if (r.error) return <ErrorBox error={r.error} retry={r.reload} />;
  return <Loading />;
}

export function Badge({ tone, children, title }: { tone?: string; children: ReactNode; title?: string }) {
  return <span className={`badge ${tone ?? ''}`} title={title}>{children}</span>;
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  const id = useId();
  const only = Children.count(children) === 1 ? Children.toArray(children)[0] : null;
  const native = isValidElement(only) && typeof only.type === 'string' && ['input', 'select', 'textarea'].includes(only.type);
  const el = native ? cloneElement(only as ReactElement<{ id?: string; 'aria-describedby'?: string }>, { id: (only as ReactElement<{ id?: string }>).props.id ?? id, 'aria-describedby': hint ? `${id}-hint` : undefined }) : children;
  return (
    <div className="field">
      <label htmlFor={native ? ((only as ReactElement<{ id?: string }>).props.id ?? id) : undefined}>{label}</label>
      {el}
      {hint && <span className="hint" id={`${id}-hint`}>{hint}</span>}
    </div>
  );
}

const FOCUSABLE = 'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    box.current?.focus();
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { close.current(); return; }
      if (e.key !== 'Tab' || !box.current) return;
      const items = Array.from(box.current.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (items.length === 0) { e.preventDefault(); return; }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const at = document.activeElement;
      if (e.shiftKey && (at === first || at === box.current)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && at === last) { e.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', k);
    return () => { window.removeEventListener('keydown', k); before?.focus?.(); };
  }, []);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={box} tabIndex={-1} className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="row" style={{ marginBottom: 'var(--tm-s-4)' }}>
          <h2 style={{ margin: 0 }}>{title}</h2>
          <button className="btn sm ghost right" onClick={onClose}>Close</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  const t = useRef<number>();
  return (
    <button
      className="btn sm"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          window.clearTimeout(t.current);
          t.current = window.setTimeout(() => setDone(false), 1500);
        });
      }}
    >
      {done ? <Check size={14} /> : <Copy size={14} />} {done ? 'Copied' : label}
    </button>
  );
}

export function Pic({ src, name, lg }: { src?: string | null; name: string; lg?: boolean }) {
  const [bad, setBad] = useState(false);
  if (!src || bad) return <div className={`pic ph ${lg ? 'lg' : ''}`} aria-hidden>{initials(name)}</div>;
  return <img className={`pic ${lg ? 'lg' : ''}`} src={src} alt="" loading="lazy" onError={() => setBad(true)} />;
}

export function PageHead({ title, children }: { title: ReactNode; children?: ReactNode }) {
  return <div className="pagehead"><h1>{title}</h1>{children}</div>;
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: string; badge?: number }[]; value: T; onChange: (t: T) => void }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (e: ReactKeyEvent, i: number) => {
    const n = tabs.length;
    let j = -1;
    if (e.key === 'ArrowRight') j = (i + 1) % n;
    else if (e.key === 'ArrowLeft') j = (i - 1 + n) % n;
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = n - 1;
    if (j < 0) return;
    e.preventDefault();
    onChange(tabs[j]!.id);
    refs.current[j]?.focus();
  };
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t, i) => (
        <button key={t.id} ref={(el) => { refs.current[i] = el; }} role="tab" aria-selected={value === t.id} tabIndex={value === t.id ? 0 : -1} className={`tab ${value === t.id ? 'active' : ''}`} onClick={() => onChange(t.id)} onKeyDown={(e) => onKey(e, i)}>
          {t.label}{t.badge ? ` (${t.badge})` : ''}
        </button>
      ))}
    </div>
  );
}
