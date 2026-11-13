// Tiny i18n: flat JSON message files, one per language. English is the fallback for missing keys.
import en from './en.json';
import de from './de.json';
import pl from './pl.json';
import fr from './fr.json';

export const langs = ['en', 'de', 'pl', 'fr'] as const;
export type Lang = (typeof langs)[number];
export const defaultLang: Lang = 'en';
export const langNames: Record<Lang, string> = { en: 'English', de: 'Deutsch', pl: 'Polski', fr: 'Français' };
/** BCP 47 tags for Intl (dates, numbers, relative times). */
export const locales: Record<Lang, string> = { en: 'en-GB', de: 'de-DE', pl: 'pl-PL', fr: 'fr-FR' };

const dict: Record<Lang, Record<string, string>> = { en, de, pl, fr };

export const isLang = (s: string | undefined): s is Lang => !!s && (langs as readonly string[]).includes(s);

/** Message lookup with {name} placeholders. Falls back to English, then to the key. */
export function t(lang: Lang, key: string, vars?: Record<string, string | number>): string {
  const s = dict[lang]?.[key] ?? en[key as keyof typeof en] ?? key;
  return vars ? s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? '')) : s;
}
/** Like t(), but returns `fallback` when no message exists in any language (data-driven labels). */
export function tf(lang: Lang, key: string, fallback: string): string {
  return dict[lang]?.[key] ?? (en as Record<string, string>)[key] ?? fallback;
}
export const has = (key: string) => key in en;

/** Path with the language prefix: English stays unprefixed. */
export const lh = (lang: Lang, p: string) => (lang === defaultLang || !p.startsWith('/') ? p : `/${lang}${p === '/' ? '/' : p}`);
/** Strip a language prefix from a pathname. */
export const unprefix = (p: string) => p.replace(/^\/(de|pl|fr)(?=\/|$)/, '') || '/';
export const langOf = (p: string): Lang => { const m = p.match(/^\/(de|pl|fr)(?=\/|$)/); return (m ? m[1] : 'en') as Lang; };

export const nf = (lang: Lang, n: number) => new Intl.NumberFormat(locales[lang]).format(n);

// Game texts (price, family, note, where to get it) are translated by key; unknown values stay as they are.
export const priceText = (lang: Lang, price: string) => tf(lang, `price.${price}`, price);
export const familyText = (lang: Lang, family: string) => tf(lang, `family.${family}`, family);
export const gameText = (lang: Lang, g: { id: string; note: string; get: string; envs: string }, field: 'note' | 'get' | 'envs') => tf(lang, `game.${g.id}.${field}`, g[field]);
