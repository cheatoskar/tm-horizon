// UI languages: English (source), Deutsch, Polski, Français. Messages are flat JSON files keyed
// by dotted ids ("home.live"); {name} placeholders are filled from vars. A missing key falls back
// to English, then to the key itself. The language comes from Settings (native: settings.json,
// preview: localStorage) or, when not chosen, from Windows / the browser.
import { createContext, Fragment, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import en from './en.json';
import de from './de.json';
import pl from './pl.json';
import fr from './fr.json';
import { backend } from '../data/backend';

export const LANGS = [
  { id: 'en', label: 'English' },
  { id: 'de', label: 'Deutsch' },
  { id: 'pl', label: 'Polski' },
  { id: 'fr', label: 'Français' },
] as const;
export type Lang = (typeof LANGS)[number]['id'];

type Dict = Record<string, string>;
// Feature strings may live in parts/<feature>.<lang>.json (keeps the big files out of every merge);
// they are added to the language's dictionary. check-i18n treats them like the main files.
const PARTS = import.meta.glob<Dict>('./parts/*.json', { eager: true, import: 'default' });
const withParts = (lang: Lang, base: Dict): Dict => {
  const out: Dict = { ...base };
  for (const [file, dict] of Object.entries(PARTS)) if (file.endsWith(`.${lang}.json`)) Object.assign(out, dict);
  return out;
};
const DICTS: Record<Lang, Dict> = { en: withParts('en', en), de: withParts('de', de), pl: withParts('pl', pl), fr: withParts('fr', fr) };

export function systemLang(): Lang {
  for (const l of navigator.languages ?? [navigator.language]) {
    const two = l.slice(0, 2).toLowerCase();
    if (two === 'de' || two === 'pl' || two === 'fr' || two === 'en') return two;
  }
  return 'en';
}

function savedLang(): string {
  const native = backend.info?.().settings.language;
  if (native !== undefined) return native;
  try { return localStorage.getItem('tmhub.lang') ?? ''; } catch { return ''; }
}

const isLang = (l: string): l is Lang => LANGS.some((x) => x.id === l);

let current: Lang = 'en';

/** Translate outside React (toasts built in callbacks use the current language too). */
type Vars = Record<string, string | number | null | undefined>;
const fill = (s: string, vars?: Vars) => (vars ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k] ?? '') : m)) : s);

export function tr(key: string, vars?: Vars): string {
  return fill(DICTS[current][key] ?? DICTS.en[key] ?? key, vars);
}

/** Like tr, but gives `fallback` when the key does not exist (labels that come from data). */
export function trOr(key: string, fallback: string): string {
  return DICTS[current][key] ?? DICTS.en[key] ?? fallback;
}

/** Plural: picks key.one / key.few / key.many / key.other by the language's rules; {n} is filled in. */
export function tp(key: string, n: number, vars?: Vars): string {
  const cat = new Intl.PluralRules(current).select(n);
  for (const d of [DICTS[current], DICTS.en]) {
    const k = [`${key}.${cat}`, `${key}.other`].find((x) => x in d);
    if (k) return fill(d[k], { n, ...vars });
  }
  return key;
}

/** tr with React nodes as values, e.g. tn('clips.emptyText', { dir: <b>{dir}</b> }). */
export function tn(key: string, vars: Record<string, ReactNode>): ReactNode {
  const s = DICTS[current][key] ?? DICTS.en[key] ?? key;
  const out: ReactNode[] = [];
  const re = /\{(\w+)\}/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(s.slice(last, m.index));
    out.push(<Fragment key={m.index}>{m[1] in vars ? vars[m[1]] : m[0]}</Fragment>);
    last = re.lastIndex;
  }
  if (last < s.length) out.push(s.slice(last));
  return <>{out}</>;
}

/** For text shown before the provider exists (boot error): pick the saved or Windows language. */
export function initLang(): void {
  try { const c = savedLang(); current = isLang(c) ? c : systemLang(); } catch { current = systemLang(); }
}

export type T = typeof tr;

interface I18n { lang: Lang; choice: string; t: T; setLang: (l: string) => Promise<void>; locale: string }
const Ctx = createContext<I18n | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [choice, setChoice] = useState<string>(() => savedLang());
  const lang: Lang = isLang(choice) ? choice : systemLang();
  current = lang;
  const t = useCallback<T>((k, v) => { current = lang; return tr(k, v); }, [lang]);
  const setLang = useCallback(async (l: string) => {
    const v = l === '' || isLang(l) ? l : '';
    if (backend.saveSettings) await backend.saveSettings({ language: v });
    else try { localStorage.setItem('tmhub.lang', v); } catch { /* preview without storage */ }
    setChoice(v);
  }, []);
  const value = useMemo(() => ({ lang, choice, t, setLang, locale: lang === 'en' ? 'en-GB' : lang }), [lang, choice, t, setLang]);
  document.documentElement.lang = lang;
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useI18n(): I18n {
  const v = useContext(Ctx);
  if (!v) throw new Error('no i18n');
  return v;
}

export const useT = () => useI18n().t;

/** "3 h ago" etc. in the current language. */
export function ago(iso: string | null | undefined): string {
  if (!iso) return '';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  const rtf = new Intl.RelativeTimeFormat(current === 'en' ? 'en-GB' : current, { numeric: 'always', style: 'short' });
  if (s < 3600) return rtf.format(-Math.max(1, Math.round(s / 60)), 'minute');
  if (s < 86400) return rtf.format(-Math.round(s / 3600), 'hour');
  const d = Math.round(s / 86400);
  if (d < 45) return rtf.format(-d, 'day');
  const m = Math.round(d / 30);
  if (m < 18) return rtf.format(-m, 'month');
  return rtf.format(-Math.round(d / 365), 'year');
}

export function fmtDateTime(iso: string): string {
  return new Intl.DateTimeFormat(current === 'en' ? 'en-GB' : current, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
}

/** A day in the UI language ("4. Nov. 2026", "4 Nov 2026"). */
export function fmtDate(iso: string | number): string {
  return new Intl.DateTimeFormat(current === 'en' ? 'en-GB' : current, { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso));
}

/** Day and time in the UI language ("4 Nov 2026, 14:05"), never the system locale. */
export function fmtStamp(iso: string | number): string {
  return new Intl.DateTimeFormat(current === 'en' ? 'en-GB' : current, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
}
