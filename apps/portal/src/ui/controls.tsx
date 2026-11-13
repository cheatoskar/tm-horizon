import { useId, useRef, useState, type ReactNode } from 'react';
import { Check, FileUp, Info, X } from 'lucide-react';
import { fmtSize } from '../labels.ts';
import { setThemePref, useThemePref, type ThemePref } from './theme.ts';

export interface Option<T extends string> {
  value: T;
  label: ReactNode;
  hint?: ReactNode;
  icon?: ReactNode;
  meta?: ReactNode;
  disabled?: boolean;
}

export function Checkbox({ checked, onChange, label, hint, disabled, icon }: {
  checked: boolean; onChange: (checked: boolean) => void; label: ReactNode; hint?: ReactNode; disabled?: boolean; icon?: ReactNode;
}) {
  return (
    <label className={`check ${disabled ? 'is-disabled' : ''}`}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="check-text">
        <span className="check-label">{icon}{label}</span>
        {hint && <span className="hint">{hint}</span>}
      </span>
    </label>
  );
}

function Tile<T extends string>({ o, on, mark, children }: { o: Option<T>; on: boolean; mark: 'round' | 'sq'; children: ReactNode }) {
  return (
    <label className={`opt ${on ? 'on' : ''} ${o.disabled ? 'is-disabled' : ''}`}>
      {children}
      {o.icon ? <span className="opt-icon" aria-hidden>{o.icon}</span> : (
        <span className={`mark ${mark}`} aria-hidden>{mark === 'sq' && <Check size={13} strokeWidth={3} />}</span>
      )}
      <span className="opt-body">
        <span className="opt-label">{o.label}</span>
        {o.hint && <span className="hint">{o.hint}</span>}
      </span>
      {o.meta && <span className="opt-meta">{o.meta}</span>}
    </label>
  );
}

export function RadioCards<T extends string>({ name, value, onChange, options, columns = 2, ariaLabel }: {
  name: string; value: T | null; onChange: (v: T) => void; options: Option<T>[]; columns?: number; ariaLabel: string;
}) {
  return (
    <div className="opts" role="radiogroup" aria-label={ariaLabel} style={{ ['--cols' as string]: columns }}>
      {options.map((o) => (
        <Tile key={o.value} o={o} on={value === o.value} mark="round">
          <input type="radio" name={name} value={o.value} checked={value === o.value} disabled={o.disabled} onChange={() => onChange(o.value)} />
        </Tile>
      ))}
    </div>
  );
}

export function CheckCards<T extends string>({ values, onChange, options, columns = 2, ariaLabel }: {
  values: T[]; onChange: (v: T[]) => void; options: Option<T>[]; columns?: number; ariaLabel: string;
}) {
  return (
    <div className="opts" role="group" aria-label={ariaLabel} style={{ ['--cols' as string]: columns }}>
      {options.map((o) => {
        const on = values.includes(o.value);
        return (
          <Tile key={o.value} o={o} on={on} mark="sq">
            <input type="checkbox" checked={on} disabled={o.disabled} onChange={(e) => onChange(e.target.checked ? [...values, o.value] : values.filter((x) => x !== o.value))} />
          </Tile>
        );
      })}
    </div>
  );
}

export function FileDrop({ accept, file, onFile, label, hint }: {
  accept?: string; file: File | null; onFile: (f: File | null) => void; label: string; hint?: ReactNode;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const pick = (f: File | null | undefined) => { if (f) onFile(f); };
  return (
    <div
      className={`drop ${over ? 'over' : ''} ${file ? 'has' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); pick(e.dataTransfer.files[0]); }}
    >
      <input ref={ref} type="file" accept={accept} className="sr" tabIndex={-1} aria-label={label} onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ''; }} />
      <span className="drop-icon" aria-hidden><FileUp size={22} /></span>
      <span className="drop-text">
        {file ? (
          <>
            <span className="drop-name">{file.name}</span>
            <span className="hint">{fmtSize(file.size)}</span>
          </>
        ) : (
          <>
            <span>{label}</span>
            <span className="hint">{hint ?? 'Drop a file here or choose one.'}</span>
          </>
        )}
      </span>
      <button type="button" className="btn sm" onClick={() => ref.current?.click()}>{file ? 'Change' : 'Choose file'}</button>
      {file && <button type="button" className="btn sm ghost" onClick={() => onFile(null)}><X size={14} /> Remove</button>}
    </div>
  );
}

export function Section({ title, help, actions, children, id }: { title: ReactNode; help?: ReactNode; actions?: ReactNode; children?: ReactNode; id?: string }) {
  const hid = useId();
  return (
    <section className="card section" id={id} aria-labelledby={hid}>
      <div className="section-head">
        <h2 id={hid}>{title}</h2>
        {actions && <div className="section-actions">{actions}</div>}
      </div>
      {help && <p className="section-help">{help}</p>}
      {children !== undefined && <div className="section-body">{children}</div>}
    </section>
  );
}

export function EmptyState({ icon, title, text, action }: { icon?: ReactNode; title: ReactNode; text?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      {icon && <div className="empty-icon" aria-hidden>{icon}</div>}
      <p className="empty-title">{title}</p>
      {text && <p className="empty-text">{text}</p>}
      {action && <div className="empty-action">{action}</div>}
    </div>
  );
}

export function InfoTip({ text }: { text: ReactNode }) {
  const id = useId();
  return (
    <span className="tipwrap">
      <button type="button" className="tip" aria-label="More information" aria-describedby={id}><Info size={15} /></button>
      <span role="tooltip" id={id} className="tipbox">{text}</span>
    </span>
  );
}

export function Stat({ label, value, tip }: { label: string; value: ReactNode; tip?: ReactNode }) {
  return (
    <div className="stat">
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}{tip && <InfoTip text={tip} />}</div>
    </div>
  );
}

const THEMES: { value: ThemePref; label: string }[] = [{ value: 'system', label: 'System' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }];

/** System / Light / Dark switch (real radio inputs, so arrow keys work). */
export function ThemeSwitch() {
  const pref = useThemePref();
  return (
    <div className="seg" role="radiogroup" aria-label="Colour theme">
      {THEMES.map((t) => (
        <label key={t.value} className={pref === t.value ? 'on' : ''}>
          <input type="radio" name="theme-pref" value={t.value} checked={pref === t.value} onChange={() => setThemePref(t.value)} />
          {t.label}
        </label>
      ))}
    </div>
  );
}
