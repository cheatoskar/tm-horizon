// Event posts of the Exchange sites (events of the month, MTC, cups, calendar sign-ups) as event
// cards. Only tmnf, tmuf, ManiaPlanet and Trackmania have a news feed; ESWC, Original and Sunrise
// get nothing. A date is shown only when the post names exactly one clear date.
import { useEffect, useState } from 'react';
import { CalendarDays, ExternalLink } from 'lucide-react';
import { backend, type ExchangePost } from '../data/backend';
import { loadExchangePosts } from '../data/news';
import { useT, fmtDate } from '../i18n';
import { BBCode } from './BBCode';
import { useCachedImage } from './common';
import { TITLES } from '../data/catalog';

const RECENT_MS = 45 * 24 * 3600_000;

/** Does a post's site belong to this launcher game? (tm.mania.exchange covers all TM² titles.) */
export function postFitsGame(p: ExchangePost, game: string): boolean {
  return p.game === game || (p.game === 'tm2-stadium' && (game.startsWith('tm2-') || game === 'sm-storm'));
}

/** Event posts that still matter: a named date today or later, or posted in the last 45 days. */
export function useExchangeEvents(game?: string): ExchangePost[] {
  const [posts, setPosts] = useState<ExchangePost[]>([]);
  useEffect(() => { let live = true; loadExchangePosts().then((p) => { if (live) setPosts(p); }); return () => { live = false; }; }, []);
  const today = new Date().toISOString().slice(0, 10);
  // Monthly series ("Events of the month - October", "MTC October 2026 - ..."): only the newest post per site.
  const newest = new Map<string, ExchangePost>();
  for (const p of posts.filter((x) => x.event)) {
    const k = p.host + '|' + seriesKey(p.title);
    const o = newest.get(k);
    if (!o || p.date > o.date) newest.set(k, p);
  }
  return [...newest.values()]
    .filter((p) => !game || postFitsGame(p, game))
    .filter((p) => (p.eventDate ? p.eventDate >= today : Date.now() - Date.parse(p.date) < RECENT_MS))
    .sort((a, b) => (a.eventDate && b.eventDate ? a.eventDate.localeCompare(b.eventDate) : a.eventDate ? -1 : b.eventDate ? 1 : b.date.localeCompare(a.date)));
}

const MONTH = /\b(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|june?|july?|aug(ust)?|sep(t(ember)?)?|oct(ober)?|nov(ember)?|dec(ember)?)\b/i;
/** Title part before the month name ("mtc", "events of the month"); titles without a month are their own series. */
function seriesKey(title: string): string {
  const t = title.toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, ' ').replace(/\s+/g, ' ').trim();
  const m = MONTH.exec(t);
  return m && m.index > 0 ? t.slice(0, m.index).trim() : t;
}

const SITE: Record<string, string> = { tmnf: 'TMNF-X', tmuf: 'TMUF-X', 'tm2-stadium': 'MX', tm2020: 'TMX' };

export function ExchangeEventCard({ p, compact = false }: { p: ExchangePost; compact?: boolean }) {
  const t = useT();
  const banner = useCachedImage(p.image);
  const day = (iso: string) => fmtDate(iso.length === 10 ? iso + 'T12:00:00' : iso);
  return (
    <div className={'xev' + (compact ? ' compact' : '')}>
      {(banner
        ? <img className={compact ? 'xev-thumb' : 'xev-banner'} src={banner} alt="" loading="lazy" />
        // Posts without a picture (Events of the month, MTC): a designed banner in the game's colours.
        : <div className={(compact ? 'xev-thumb' : 'xev-banner') + ' xev-ph'} style={{ background: TITLES.find((x) => x.id === p.game)?.gradient }} aria-hidden>
            <span className="xev-ph-stripes" />
            <CalendarDays size={compact ? 20 : 34} strokeWidth={1.6} />
            {!compact && <span className="xev-ph-site">{SITE[p.game] ?? p.host}</span>}
          </div>)}
      <div className="xev-body">
        <div className="xev-meta small">
          <span className="pill tiny">{SITE[p.game] ?? p.host}</span>
          <CalendarDays size={12} />
          {p.eventDate ? <b>{day(p.eventDate)}</b> : <span className="dim">{t('xev.posted', { date: day(p.date) })}</span>}
          {p.author && <span className="dim">· {p.author}</span>}
        </div>
        <b className="xev-title clamp2" title={p.title}>{p.title}</b>
        {!compact && p.message && (
          <details className="xev-more">
            <summary className="dim small">{t('xev.preview')}</summary>
            <BBCode text={p.message} />
          </details>
        )}
        <button className="btn ghost sm" onClick={() => backend.openExternal(p.link)} title={p.link}><ExternalLink size={13} /> {t('xev.read')}</button>
      </div>
    </div>
  );
}
