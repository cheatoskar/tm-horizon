// Statistics: play time, sessions, saved runs and best times per game and per map, from real data
// only (launcher process tracking, the player's own replays, Horizon Client events when present).
// TMNF/TMUF's own race counters are not used (often wrong); only the profiles' play time counter is, shown
// as "before TM Horizon" on the game tile (the part TM Horizon did not count itself). Rust: src-tauri/src/stats.rs.
// Layout: game tiles on their covers (click = filter), a year calendar of runs or play time, runs per
// month next to play time per day/week, the most played maps with their TMX pictures, the map table.
import { useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { ArrowDown, ArrowUp, BarChart3, Info, Loader2, RefreshCw, Table2 } from 'lucide-react';
import { copyChoices, firstDesc, shownBest, statsIntent, tableRows, tmxPage, tmxThumbDirect, tmxThumbProxy, type SortKey } from '../data/statsView.ts';
import { isNative } from '../data/backend';
import { tp, useI18n } from '../i18n';
import { stripTm } from '../data/tmformat.ts';
import { TmRich } from '../ui/hosting/TmPreview';
import { go, useHubState } from '../state';
import { useFormatTime, useFormatTimeShort } from '../ui/Playtime';
import { GameArt, useCachedImage } from '../ui/common';
import { openRelated } from '../data/links';
import { InspectButton } from '../ui/InspectButton';
import '../styles-stats.css';

interface GameCard {
  family: string; seconds: Record<string, number>; sessions: number; lastPlayed: number; maps: number; runs: number;
  finishes: number | null; respawns: number | null; folders: string[]; hostEvents: boolean;
  /** TMNF/TMUF: the game's own play time per local profile, and the part from before TM Horizon counted. */
  profiles?: { name: string; seconds: number }[]; profileSeconds?: number; beforeSeconds?: number;
}
interface MapRow {
  family: string; uid: string; name: string; env: string | null; runs: number; bestMs: number | null; bestRespawns: number | null;
  bestAt: number | null; lastAt: number; finishes: number | null; starts: number | null; respawns: number | null; hostBestMs: number | null;
  cleanRuns: number; cleanBestMs: number | null;
  /** One of the game's own campaign maps (author Nadeo). */
  campaign?: boolean;
}
interface CopyInfo { id: string; family: string; label: string; path: string }
interface Day { day: string; family: string; seconds: number }
interface Month { month: string; family: string; runs: number; pbs: number }
interface RunDay { day: string; family: string; runs: number; pbs: number }
interface Report {
  games: GameCard[]; maps: MapRow[]; days: Day[]; files: number; foreign: number; duplicates: number; generatedAt: string;
  pending: number; indexing: boolean; newFiles: number; parsedFiles: number; playtimeSince: number; timeline: Month[]; runDays?: RunDay[];
  copies?: CopyInfo[]; copy?: string | null;
}
interface TmxHit { uid: string; site: string | null; trackId: number | null }

/** Map names carry TrackMania format codes: coloured and styled, never as raw "$o$f00". */
function MapName({ name }: { name: string }) {
  return <span className="st-map" title={stripTm(name)}><TmRich text={name} safe /></span>;
}

const FAMILY_NAME: Record<string, string> = { forever: 'TMNF / TMUF', maniaplanet: 'ManiaPlanet', tm2020: 'Trackmania', 'tmn-eswc': 'Nations ESWC', 'tm-sunrise': 'Sunrise', 'tm-original': 'Original' };
/** The game whose cover stands for a family (the most played one where several share it). */
const FAMILY_COVER: Record<string, string> = { forever: 'tmnf', maniaplanet: 'tm2-stadium', tm2020: 'tm2020', 'tmn-eswc': 'tmn-eswc', 'tm-sunrise': 'tm-sunrise', 'tm-original': 'tm-original' };

/** 45230 -> "0:45.23" (Forever and older: hundredths; ManiaPlanet and Trackmania: thousandths). */
export function fmtRace(ms: number | null, family: string): string {
  if (ms == null) return '–';
  const thousandths = family === 'tm2020' || family === 'maniaplanet';
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const frac = thousandths ? String(ms % 1000).padStart(3, '0') : String(Math.floor((ms % 1000) / 10)).padStart(2, '0');
  return `${m}:${String(s).padStart(2, '0')}.${frac}`;
}

/** Play time of a game: what TM Horizon counted plus, for TMNF/TMUF, the profiles' time from before. */
const sumSeconds = (g: GameCard) => Object.values(g.seconds).reduce((a, b) => a + b, 0) + (g.beforeSeconds ?? 0);
const utcDay = (d: Date) => d.toISOString().slice(0, 10);

/** Width of an element, kept up to date (charts are drawn at their real width, text keeps its size). */
function useWidth(dep: unknown): [React.RefObject<HTMLDivElement>, number] {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(280, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, [dep]);
  return [box, width];
}

/** Section heading with the data source behind an info icon instead of a paragraph under every chart. */
function Head({ title, sub, note, children }: { title: string; sub?: string; note?: string; children?: React.ReactNode }) {
  return (
    <div className="st-head">
      <div className="st-head-text">
        <h2>{title}{note && <span className="st-info" title={note} aria-label={note} tabIndex={0}><Info size={14} /></span>}</h2>
        {sub && <span className="dim small">{sub}</span>}
      </div>
      {children && <div className="row-btns">{children}</div>}
    </div>
  );
}

/** One tile per game family on its cover: play time big, runs, maps and sessions under it. A click filters the page. */
function GameTiles({ games, fam, setFam }: { games: GameCard[]; fam: string; setFam: (f: string) => void }) {
  const { t, locale } = useI18n();
  const fmt = useFormatTime();
  const fmtShort = useFormatTimeShort();
  const hub = useHubState();
  const n = (x: number) => x.toLocaleString(locale);
  const sorted = [...games].sort((a, b) => sumSeconds(b) - sumSeconds(a) || b.runs - a.runs);
  return (
    <div className="st-tiles-row" role="radiogroup" aria-label={t('stats.game')}>
      {sorted.map((g) => {
        const cover = Object.entries(g.seconds).sort((a, b) => b[1] - a[1])[0]?.[0] ?? FAMILY_COVER[g.family];
        const view = hub.game(cover) ?? hub.game(FAMILY_COVER[g.family]);
        const total = sumSeconds(g);
        const on = fam === g.family;
        return (
          <button key={g.family} role="radio" aria-checked={on} className={'st-gt' + (on ? ' on' : '') + (fam && !on ? ' off' : '')} onClick={() => setFam(on ? '' : g.family)}>
            {view && <GameArt game={view} variant="cover" className="st-gt-bg" />}
            <span className="st-gt-shade" />
            <span className="st-gt-body">
              <span className="st-gt-name">{FAMILY_NAME[g.family] ?? g.family}</span>
              <b className="st-gt-time" title={total ? fmt(total) : undefined}>{total ? fmtShort(total) : `${n(g.runs)} ${t('stats2.runsShort')}`}</b>
              <span className="st-gt-nums">
                {total > 0 && <span><b>{n(g.runs)}</b> {t('stats2.runsShort')}</span>}
                <span><b>{n(g.maps)}</b> {t('stats2.mapsShort')}</span>
                {g.sessions > 0 && <span><b>{n(g.sessions)}</b> {t('stats2.sessionsShort')}</span>}
                {g.hostEvents && <span><b>{n(g.finishes ?? 0)}</b> {t('stats2.finishesShort')}</span>}
              </span>
              {(g.beforeSeconds ?? 0) > 0 && (
                <span className="st-gt-before" title={t('stats.beforeTip', { list: (g.profiles ?? []).map((p) => `${p.name} ${fmt(p.seconds)}`).join(', ') })}>
                  {t('stats.beforeHorizon', { time: fmt(g.beforeSeconds ?? 0) })}
                </span>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}

type Metric = 'runs' | 'time';

/** GitHub-style year calendar: one square per day, columns are weeks (Monday first), last 53 weeks. */
function Calendar({ runDays, days }: { runDays: RunDay[]; days: Day[] }) {
  const { t, locale } = useI18n();
  const fmt = useFormatTime();
  const [metric, setMetric] = useState<Metric>('runs');
  const [hover, setHover] = useState<{ i: number; x: number; y: number } | null>(null);
  const [box, width] = useWidth(metric);
  const data = useMemo(() => {
    const runs = new Map<string, { runs: number; pbs: number }>();
    for (const d of runDays) { const e = runs.get(d.day) ?? { runs: 0, pbs: 0 }; e.runs += d.runs; e.pbs += d.pbs; runs.set(d.day, e); }
    const secs = new Map<string, number>();
    for (const d of days) secs.set(d.day, (secs.get(d.day) ?? 0) + d.seconds);
    const now = new Date();
    const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const dow = (today.getUTCDay() + 6) % 7; // Monday = 0
    const start = new Date(today.getTime() - (52 * 7 + dow) * 86_400_000);
    const cells: { day: string; col: number; row: number; runs: number; pbs: number; secs: number }[] = [];
    for (let i = 0; ; i++) {
      const d = new Date(start.getTime() + i * 86_400_000);
      if (d > today) break;
      const k = utcDay(d);
      cells.push({ day: k, col: Math.floor(i / 7), row: i % 7, runs: runs.get(k)?.runs ?? 0, pbs: runs.get(k)?.pbs ?? 0, secs: secs.get(k) ?? 0 });
    }
    return cells;
  }, [runDays, days]);
  const val = (c: (typeof data)[number]) => (metric === 'runs' ? c.runs : c.secs);
  const values = data.map(val).filter((v) => v > 0).sort((a, b) => a - b);
  // Four steps by quartiles of the active days, so one huge day does not wash out the rest.
  const q = (p: number) => values[Math.min(values.length - 1, Math.floor(values.length * p))] ?? 0;
  const steps = [q(0.25), q(0.5), q(0.75)];
  const level = (v: number) => (v <= 0 ? 0 : v <= steps[0] ? 1 : v <= steps[1] ? 2 : v <= steps[2] ? 3 : 4);
  const cols = (data.at(-1)?.col ?? 52) + 1;
  const L = 30, T = 18;
  const cell = Math.max(9, Math.min(15, Math.floor((width - L) / cols) - 3));
  const gap = 3, pitch = cell + gap;
  const W = L + cols * pitch, H = T + 7 * pitch;
  const monthName = (d: string) => new Intl.DateTimeFormat(locale, { month: 'short', timeZone: 'UTC' }).format(new Date(d + 'T00:00:00Z'));
  const dayName = (d: string) => new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(d + 'T00:00:00Z'));
  const weekdays = [0, 2, 4].map((r) => ({ r, label: new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(2024, 0, 1 + r))) }));
  const months = data.filter((c) => c.row === 0 && (c.col === 0 ? false : c.day.slice(8) <= '07'));
  const totalRuns = data.reduce((a, c) => a + c.runs, 0);
  const totalSecs = data.reduce((a, c) => a + c.secs, 0);
  const active = data.filter((c) => val(c) > 0).length;
  const h = hover != null ? data[hover.i] : null;
  return (
    <section className="st-sec">
      <Head title={t('stats2.calendar')} note={metric === 'runs' ? t('stats.noteMonths') : t('stats.noteDays', { since: '' })}
        sub={metric === 'runs' ? t('stats2.calSubRuns', { runs: totalRuns.toLocaleString(locale), days: active }) : t('stats2.calSubTime', { time: fmt(totalSecs), days: active })}>
        <div className="seg small-seg" role="radiogroup" aria-label={t('stats2.calendar')}>
          {(['runs', 'time'] as const).map((m) => <button key={m} role="radio" aria-checked={metric === m} className={metric === m ? 'on' : ''} onClick={() => setMetric(m)}>{t(m === 'runs' ? 'stats2.metricRuns' : 'stats2.metricTime')}</button>)}
        </div>
      </Head>
      <div className="st-cal" ref={box} onMouseLeave={() => setHover(null)}>
        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={t('stats2.calendar')}>
          {months.map((c) => <text key={c.day} x={L + c.col * pitch} y={11} className="st-axis">{monthName(c.day)}</text>)}
          {weekdays.map((w) => <text key={w.r} x={0} y={T + w.r * pitch + cell - 2} className="st-axis">{w.label}</text>)}
          {data.map((c, i) => (
            <rect key={c.day} x={L + c.col * pitch} y={T + c.row * pitch} width={cell} height={cell} rx={2.5}
              className={`st-cal-c l${level(val(c))}${hover?.i === i ? ' on' : ''}`}
              onMouseEnter={(e) => setHover({ i, x: L + c.col * pitch + cell / 2, y: T + c.row * pitch })}
              aria-label={`${dayName(c.day)}: ${metric === 'runs' ? c.runs : fmt(c.secs)}`} />
          ))}
        </svg>
        {h && (
          <div className="st-tip" style={{ left: hover!.x, top: hover!.y - 8, transform: 'translate(-50%, -100%)' }}>
            <b>{dayName(h.day)}</b>
            <span>{tp('stats2.nRuns', h.runs)}{h.pbs > 0 ? ` · ${tp('stats2.nPbs', h.pbs)}` : ''}</span>
            <span className="dim">{h.secs > 0 ? fmt(h.secs) : t('stats2.noTime')}</span>
          </div>
        )}
        <div className="st-cal-legend dim small" aria-hidden>
          {t('stats2.less')}{[0, 1, 2, 3, 4].map((l) => <i key={l} className={`st-cal-c l${l}`} />)}{t('stats2.more')}
        </div>
      </div>
    </section>
  );
}

/** Play time per day (30 / 90 days) or per week (52 weeks), with a hover tooltip and a table view. */
function PlayChart({ days, since }: { days: Day[]; since: string }) {
  const { t, locale } = useI18n();
  const fmt = useFormatTime();
  const [table, setTable] = useState(false);
  const [range, setRange] = useState<30 | 90 | 52>(30);
  const [hover, setHover] = useState<number | null>(null);
  const [box, width] = useWidth(table);
  const series = useMemo(() => {
    const byDay = new Map<string, number>();
    for (const d of days) byDay.set(d.day, (byDay.get(d.day) ?? 0) + d.seconds);
    const now = new Date();
    const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const out: { key: string; total: number }[] = [];
    if (range === 52) {
      const dow = (new Date(today).getUTCDay() + 6) % 7;
      const monday = today - dow * 86_400_000;
      for (let w = 51; w >= 0; w--) {
        const from = monday - w * 7 * 86_400_000;
        let s = 0;
        for (let d = 0; d < 7; d++) s += byDay.get(utcDay(new Date(from + d * 86_400_000))) ?? 0;
        out.push({ key: utcDay(new Date(from)), total: s });
      }
    } else {
      for (let i = range - 1; i >= 0; i--) { const k = utcDay(new Date(today - i * 86_400_000)); out.push({ key: k, total: byDay.get(k) ?? 0 }); }
    }
    return out;
  }, [days, range]);
  const max = Math.max(...series.map((s) => s.total), 1);
  const stepS = max > 4 * 3600 ? Math.ceil(max / 3600 / 4) * 3600 : max > 3600 ? 3600 : Math.max(900, Math.ceil(max / 4 / 900) * 900);
  const top = Math.max(stepS, Math.ceil(max / stepS) * stepS);
  const ticks = Array.from({ length: Math.round(top / stepS) + 1 }, (_, i) => i * stepS);
  const W = width, H = 180, L = 46, B = 22, slot = (W - L) / series.length, bw = Math.max(2, Math.min(14, slot - 2));
  const y = (v: number) => H - B - (v / top) * (H - B - 8);
  const label = (d: string) => new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(d + 'T00:00:00Z'));
  const tick = (v: number) => (v >= 3600 && v % 3600 === 0 ? `${v / 3600} h` : `${Math.round(v / 60)} min`);
  const total = series.reduce((a, s) => a + s.total, 0);
  const every = range === 30 ? 7 : range === 90 ? 14 : 8;
  const hoverLabel = (i: number) => (range === 52 ? t('stats2.weekOf', { date: label(series[i].key) }) : label(series[i].key));
  return (
    <section className="st-sec">
      <Head title={range === 52 ? t('stats2.perWeek') : t('stats.perDay')} note={t('stats.noteDays', { since })}
        sub={range === 52 ? t('stats2.perWeekSub', { total: fmt(total) }) : t('stats.perDaySub2', { days: range, total: fmt(total) })}>
        <div className="seg small-seg" role="radiogroup" aria-label={t('stats.perDay')}>
          {([30, 90, 52] as const).map((r) => <button key={r} role="radio" aria-checked={range === r} className={range === r ? 'on' : ''} onClick={() => setRange(r)}>{r === 52 ? t('stats2.range52w') : t('stats.range' + r)}</button>)}
        </div>
        {total > 0 && <button className="btn ghost sm" aria-pressed={table} onClick={() => setTable(!table)} title={table ? t('stats.chart') : t('stats.table')}>{table ? <BarChart3 size={14} /> : <Table2 size={14} />}</button>}
      </Head>
      {total === 0 && <p className="dim small st-empty">{t('stats.noSessions2', { days: range === 52 ? 364 : range, since })}</p>}
      {total > 0 && !table && (
        <div className="st-chart" ref={box} onMouseLeave={() => setHover(null)}>
          <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={t('stats.perDay')}>
            {ticks.map((v) => (<g key={v}><line x1={L} x2={W} y1={y(v)} y2={y(v)} className="st-grid" /><text x={L - 6} y={y(v) + 4} className="st-axis" textAnchor="end">{tick(v)}</text></g>))}
            {series.map((s, i) => {
              const x = L + i * slot + (slot - bw) / 2;
              const h = H - B - y(s.total);
              return (
                <g key={s.key}>
                  {s.total > 0 && <rect className={'st-bar' + (hover === i ? ' on' : '')} x={x} y={y(s.total)} width={bw} height={h} rx={Math.min(3, bw / 2)} />}
                  <rect x={L + i * slot} y={0} width={slot} height={H - B} fill="transparent" onMouseEnter={() => setHover(i)} />
                  {(i % every === every - 1 || i === series.length - 1) && <text x={L + i * slot + slot / 2} y={H - 6} className="st-axis" textAnchor="middle">{label(s.key)}</text>}
                </g>
              );
            })}
          </svg>
          {hover !== null && series[hover].total > 0 && (
            <div className="st-tip" style={{ left: `${((L + hover * slot + slot / 2) / W) * 100}%`, transform: 'translateX(-50%)' }}>
              <b>{hoverLabel(hover)}</b><span>{fmt(series[hover].total)}</span>
            </div>
          )}
        </div>
      )}
      {total > 0 && table && (
        <table className="st-table compact">
          <thead><tr><th>{range === 52 ? t('stats2.week') : t('stats.day')}</th><th className="num">{t('stats.playtime')}</th></tr></thead>
          <tbody>{series.map((s, i) => ({ s, i })).filter(({ s }) => s.total > 0).reverse().map(({ s, i }) => <tr key={s.key}><td>{hoverLabel(i)}</td><td className="num">{fmt(s.total)}</td></tr>)}</tbody>
        </table>
      )}
    </section>
  );
}

/** Saved runs and new personal bests per month (last 12 months), from the replay files' dates. */
function MonthChart({ timeline }: { timeline: Month[] }) {
  const { t, locale } = useI18n();
  const [hover, setHover] = useState<number | null>(null);
  const [box, width] = useWidth(timeline.length > 0);
  const series = useMemo(() => {
    const by = new Map<string, { runs: number; pbs: number }>();
    for (const m of timeline) { const e = by.get(m.month) ?? { runs: 0, pbs: 0 }; e.runs += m.runs; e.pbs += m.pbs; by.set(m.month, e); }
    const out: { month: string; runs: number; pbs: number }[] = [];
    const now = new Date();
    for (let i = 11; i >= 0; i--) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1)).toISOString().slice(0, 7);
      out.push({ month: d, ...(by.get(d) ?? { runs: 0, pbs: 0 }) });
    }
    return out;
  }, [timeline]);
  const total = series.reduce((a, s) => a + s.runs, 0);
  const pbs = series.reduce((a, s) => a + s.pbs, 0);
  const max = Math.max(...series.map((s) => s.runs), 1);
  const unit = max > 40 ? 10 : 1;
  const stepV = Math.max(1, Math.ceil(max / 4 / unit) * unit);
  const top = Math.ceil(max / stepV) * stepV;
  const ticks = Array.from({ length: top / stepV + 1 }, (_, i) => i * stepV);
  const W = width, H = 180, L = 38, B = 22, slot = (W - L) / series.length, bw = Math.max(3, Math.min(12, (slot - 6) / 2));
  const y = (v: number) => H - B - (v / top) * (H - B - 8);
  const label = (m: string) => new Intl.DateTimeFormat(locale, { month: 'short', timeZone: 'UTC' }).format(new Date(m + '-01T00:00:00Z'));
  const full = (m: string) => new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(m + '-01T00:00:00Z'));
  return (
    <section className="st-sec">
      <Head title={t('stats.perMonth')} note={t('stats.noteMonths')} sub={t('stats.perMonthSub', { runs: total, pbs })}>
        <div className="st-legend small"><span><i className="st-key runs" />{t('stats.runs')}</span><span><i className="st-key pbs" />{t('stats.newPbs')}</span></div>
      </Head>
      {total === 0 ? <p className="dim small st-empty">{t('stats.noRuns')}</p> : (
        <div className="st-chart" ref={box} onMouseLeave={() => setHover(null)}>
          <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={t('stats.perMonthSub', { runs: total, pbs })}>
            {ticks.map((v) => (<g key={v}><line x1={L} x2={W} y1={y(v)} y2={y(v)} className="st-grid" /><text x={L - 6} y={y(v) + 4} className="st-axis" textAnchor="end">{v}</text></g>))}
            {series.map((s, i) => {
              const x0 = L + i * slot + (slot - 2 * bw - 2) / 2;
              return (
                <g key={s.month}>
                  {s.runs > 0 && <rect className={'st-bar' + (hover === i ? ' on' : '')} x={x0} y={y(s.runs)} width={bw} height={H - B - y(s.runs)} rx={Math.min(3, bw / 2)} />}
                  {s.pbs > 0 && <rect className={'st-bar pb' + (hover === i ? ' on' : '')} x={x0 + bw + 2} y={y(s.pbs)} width={bw} height={H - B - y(s.pbs)} rx={Math.min(3, bw / 2)} />}
                  <rect x={L + i * slot} y={0} width={slot} height={H - B} fill="transparent" onMouseEnter={() => setHover(i)} />
                  <text x={L + i * slot + slot / 2} y={H - 6} className="st-axis" textAnchor="middle">{label(s.month)}</text>
                </g>
              );
            })}
          </svg>
          {hover !== null && series[hover].runs > 0 && (
            <div className="st-tip" style={{ left: `${((L + hover * slot + slot / 2) / W) * 100}%`, transform: 'translateX(-50%)' }}>
              <b>{full(series[hover].month)}</b>
              <span>{t('stats.runs')}: {series[hover].runs}</span>
              <span>{t('stats.newPbs')}: {series[hover].pbs}</span>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/** TMX pages of maps: asked in small batches (the visible rows), kept for the session; "not on TMX" too. */
const tmxKnown = new Map<string, TmxHit | null>();
const tmxWaiting = new Map<string, Set<string>>();
const tmxListeners = new Set<() => void>();
let tmxTimer = 0;
function askTmx(family: string, uid: string) {
  const key = family + '|' + uid;
  if (tmxKnown.has(key) || !isNative) return;
  if (!['forever', 'tmn-eswc', 'tm-sunrise', 'tm-original', 'maniaplanet', 'tm2020'].includes(family)) { tmxKnown.set(key, null); return; }
  const set = tmxWaiting.get(family) ?? new Set<string>();
  set.add(uid);
  tmxWaiting.set(family, set);
  if (tmxTimer) return;
  tmxTimer = window.setTimeout(async () => {
    tmxTimer = 0;
    for (const [fam, uids] of [...tmxWaiting]) {
      tmxWaiting.delete(fam);
      const list = [...uids];
      for (let i = 0; i < list.length; i += 12) {
        const part = list.slice(i, i + 12);
        const hits = await invoke<TmxHit[]>('stats_tmx', { family: fam, uids: part }).catch(() => [] as TmxHit[]);
        for (const u of part) tmxKnown.set(fam + '|' + u, hits.find((h) => h.uid === u) ?? null);
        tmxListeners.forEach((f) => f());
      }
    }
  }, 400);
}
function useTmxHit(family: string, uid: string, enabled: boolean): TmxHit | null | undefined {
  const key = family + '|' + uid;
  const [, setN] = useState(0);
  useEffect(() => {
    const f = () => setN((n) => n + 1);
    tmxListeners.add(f);
    return () => { tmxListeners.delete(f); };
  }, []);
  useEffect(() => { if (enabled) askTmx(family, uid); }, [key, enabled]);
  return tmxKnown.has(key) ? tmxKnown.get(key) : undefined;
}

const ownThumbs = new Map<string, Promise<string | null>>();
const ownThumb = (uid: string) => {
  let p = ownThumbs.get(uid);
  if (!p) { p = invoke<string | null>('stats_map_thumb', { uid }).catch(() => null); ownThumbs.set(uid, p); }
  return p;
};

/** A map's picture: the one in its own .Gbx (upside down there), else its TMX thumbnail through TM Horizon's
 * image proxy (campaign maps have no local file), else straight from TMX, else the environment as text. */
function MapPic({ m, hit }: { m: MapRow; hit: TmxHit | null | undefined }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [seen, setSeen] = useState(typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    const el = ref.current;
    if (seen || !el) return;
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { setSeen(true); io.disconnect(); } }, { rootMargin: '200px' });
    io.observe(el);
    return () => io.disconnect();
  }, [seen]);
  const [own, setOwn] = useState<string | null | undefined>(undefined);
  useEffect(() => { if (seen && isNative) void ownThumb(m.uid).then(setOwn); else if (!isNative) setOwn(null); }, [m.uid, seen]);
  const tmx = useTmxHit(m.family, m.uid, seen && own === null && hit === undefined);
  const h = hit ?? tmx;
  const [direct, setDirect] = useState(false);
  // TMX through the proxy first; Mania Exchange and Trackmania Exchange have no proxy and come direct.
  const url = own === null && h?.site && h.trackId ? (direct ? tmxThumbDirect(h.site, h.trackId) : tmxThumbProxy(h.site, h.trackId) ?? tmxThumbDirect(h.site, h.trackId)) : null;
  const src = useCachedImage(url, seen);
  useEffect(() => { if (url && src === null && !direct) setDirect(true); }, [url, src, direct]);
  const ph = <span className="st-tm-ph">{m.env ?? ''}</span>;
  return (
    <span ref={ref} className="st-pic">
      {own ? <img src={own} alt="" className="flip" /> : src ? <img src={src} alt="" /> : ph}
    </span>
  );
}

/** Badge for the game's own campaign maps (author Nadeo), so they never pass for community maps. */
function Campaign() {
  const { t } = useI18n();
  return <span className="pill tiny muted st-campaign" title={t('stats.campaignTip')}>{t('stats.campaign')}</span>;
}

/** The maps with the most saved runs, with the map's picture from its exchange page where one is known. */
function TopMaps({ maps }: { maps: MapRow[] }) {
  const { t, locale } = useI18n();
  const hub = useHubState();
  const top = useMemo(() => [...maps].filter((m) => m.runs > 0).sort((a, b) => b.runs - a.runs).slice(0, 8), [maps]);
  const [, setN] = useState(0);
  useEffect(() => {
    const f = () => setN((n) => n + 1);
    tmxListeners.add(f);
    for (const m of top) askTmx(m.family, m.uid);
    return () => { tmxListeners.delete(f); };
  }, [top]);
  const max = Math.max(...top.map((m) => m.runs), 1);
  return (
    <section className="st-sec">
      <Head title={t('stats.topMaps')} note={t('stats.noteTop')} />
      {top.length === 0 ? <p className="dim small st-empty">{t('stats.noRuns')}</p> : (
        <ol className="st-topgrid">
          {top.map((m, i) => {
            const h = tmxKnown.get(m.family + '|' + m.uid) ?? null;
            const url = tmxPage(h?.site, h?.trackId);
            const game = m.family === 'forever' ? (h?.site === 'tmuf.exchange' ? 'tmuf' : 'tmnf') : FAMILY_COVER[m.family];
            const inner = (
              <>
                <span className="st-tm-pic">
                  <MapPic m={m} hit={tmxKnown.has(m.family + '|' + m.uid) ? h : undefined} />
                  <span className="st-tm-rank">{i + 1}</span>
                </span>
                <span className="st-tm-text">
                  <MapName name={m.name || m.uid} />
                  <span className="st-tm-meta">
                    <span><b>{m.runs.toLocaleString(locale)}</b> {t('stats2.runsShort')}{m.campaign && <Campaign />}</span>
                    <span className="mono">{fmtRace(m.bestMs ?? m.hostBestMs, m.family)}</span>
                  </span>
                  <span className="st-tm-bar" aria-hidden><i style={{ width: `${Math.max(3, (m.runs / max) * 100)}%` }} /></span>
                </span>
              </>
            );
            return (
              <li key={m.family + m.uid}>
                {url
                  ? <button className="st-tm" title={t('stats2.openTmx')} onClick={() => openRelated(hub, go, { kind: 'website', label: '', url }, game)}>{inner}</button>
                  : <div className="st-tm">{inner}</div>}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

function MapTable({ maps, fam }: { maps: MapRow[]; fam: string }) {
  const { t, locale } = useI18n();
  const [q, setQ] = useState(() => { const x = statsIntent.q; statsIntent.q = ''; return x; });
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'lastAt', desc: true });
  const [clean, setClean] = useState(false);
  const [limit, setLimit] = useState(100);
  const families = [...new Set(maps.map((m) => m.family))];
  const hasHost = maps.some((m) => m.finishes != null || m.starts != null);
  const rows = useMemo(() => tableRows(maps, { fam, q, clean, sort }, stripTm), [maps, fam, q, clean, sort]);
  const head = (key: SortKey, label: string, num = false, tip?: string) => (
    <th className={num ? 'num' : ''} title={tip} aria-sort={sort.key === key ? (sort.desc ? 'descending' : 'ascending') : 'none'}>
      <button className="st-sort" onClick={() => setSort({ key, desc: sort.key === key ? !sort.desc : firstDesc(key) })}>
        {label}{sort.key === key && (sort.desc ? <ArrowDown size={12} /> : <ArrowUp size={12} />)}
      </button>
    </th>
  );
  const date = (ms: number) => new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(ms));
  const showGame = !fam && families.length > 1;
  return (
    <section className="st-sec">
      <Head title={t('stats.perMap')} sub={tp('stats.nMaps', rows.length)} note={t('stats.noteMaps')}>
        <button className={'fchip' + (clean ? ' on' : '')} aria-pressed={clean} title={t('stats.cleanTip')} onClick={() => setClean(!clean)}>{t('stats.cleanOnly')}</button>
        <input className="text-in" type="search" placeholder={t('stats.search')} aria-label={t('stats.search')} value={q} onChange={(e) => setQ(e.target.value)} />
      </Head>
      <div className="st-table-wrap">
        <table className="st-table">
          <thead>
            <tr>
              {head('name', t('stats.map'))}
              {showGame && <th>{t('stats.game')}</th>}
              {head('runs', t('stats.runs'), true)}
              {head('bestMs', t('stats.best'), true)}
              {head('bestRespawns', t('stats.bestRespawns'), true, t('stats.respawnsTip'))}
              {hasHost && head('finishes', t('stats.finishes'), true)}
              {hasHost && head('starts', t('stats.attempts'), true)}
              {head('lastAt', t('stats.lastPlayed'), true)}
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, limit).map((m) => (
              <tr key={m.family + m.uid}>
                <td><span className="st-cell-map"><MapPic m={m} hit={undefined} /><span><MapName name={m.name || m.uid} />{m.env && <span className="dim small"> · {m.env}</span>}{m.campaign && <Campaign />} <InspectButton target={{ uid: m.uid, family: m.family }} /></span></span></td>
                {showGame && <td className="dim">{FAMILY_NAME[m.family] ?? m.family}</td>}
                <td className="num">{(clean ? m.cleanRuns : m.runs) || '–'}</td>
                <td className="num mono">{fmtRace(shownBest(m, clean), m.family)}</td>
                <td className="num">{clean ? 0 : m.bestRespawns ?? '–'}</td>
                {hasHost && <td className="num">{m.finishes ?? '–'}</td>}
                {hasHost && <td className="num">{m.starts ?? '–'}</td>}
                <td className="num dim">{m.lastAt ? date(m.lastAt) : '–'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > limit && <button className="btn ghost sm st-more" onClick={() => setLimit(limit + 200)}>{t('stats.more')}</button>}
    </section>
  );
}

export function Stats({ initial }: { initial?: string }) {
  const { t, locale } = useI18n();
  const fmt = useFormatTime();
  const [rep, setRep] = useState<Report | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [fam, setFam] = useState(initial && FAMILY_NAME[initial] ? initial : '');
  // One game copy only ('' = all copies of every game).
  const [copy, setCopy] = useState('');
  const load = (silent = false, full = false, only = copy) => {
    if (!silent) setBusy(true);
    return invoke<Report>('stats_report', { refresh: !silent, full, copy: only || null }).then((r) => { setRep(r); setErr(''); return r; }).catch((e) => { setErr(String(e)); return null; }).finally(() => setBusy(false));
  };
  useEffect(() => { if (isNative) void load(); }, []);
  const pickCopy = (id: string) => {
    setCopy(id);
    const c = rep?.copies?.find((x) => x.id === id);
    if (c && fam && c.family !== fam) setFam(c.family);
    void load(true, false, id);
  };
  const pickFam = (f: string) => {
    setFam(f);
    const c = rep?.copies?.find((x) => x.id === copy);
    if (copy && c && f && c.family !== f) pickCopy('');
  };
  const choices = copyChoices(rep?.copies ?? [], fam);
  // The first report comes from the cache right away; while the background parse runs, ask again.
  useEffect(() => {
    if (!rep?.indexing) return;
    const id = window.setTimeout(() => { void load(true); }, 2000);
    return () => window.clearTimeout(id);
  }, [rep]);
  const view = useMemo(() => {
    if (!rep) return null;
    const ok = (f: string) => !fam || f === fam;
    return { maps: rep.maps.filter((m) => ok(m.family)), days: rep.days.filter((d) => ok(d.family)), timeline: rep.timeline.filter((m) => ok(m.family)), runDays: (rep.runDays ?? []).filter((d) => ok(d.family)) };
  }, [rep, fam]);
  const since = rep?.playtimeSince ? t('stats.since', { date: new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(rep.playtimeSince)) }) : '';
  const totals = rep ? {
    secs: rep.games.filter((g) => !fam || g.family === fam).reduce((a, g) => a + sumSeconds(g), 0),
    runs: rep.games.filter((g) => !fam || g.family === fam).reduce((a, g) => a + g.runs, 0),
    maps: rep.games.filter((g) => !fam || g.family === fam).reduce((a, g) => a + g.maps, 0),
  } : null;
  return (
    <div className="page stats-page">
      <div className="page-head">
        <div>
          <h1>{t('nav.stats')}</h1>
          {totals && rep && rep.games.length > 0
            ? <span className="dim">{fam ? FAMILY_NAME[fam] + ' · ' : ''}{totals.secs ? t('stats2.summary', { time: fmt(totals.secs), runs: totals.runs.toLocaleString(locale), maps: totals.maps.toLocaleString(locale) }) : t('stats2.summaryNoTime', { runs: totals.runs.toLocaleString(locale), maps: totals.maps.toLocaleString(locale) })}</span>
            : <span className="dim">{t('stats.sub')}</span>}
        </div>
        <div className="grow" />
        {rep?.indexing && (
          <span className="dim small st-progress" role="status"><Loader2 size={13} className="spin" /> {rep.newFiles > 0 ? t('stats.indexing', { done: rep.parsedFiles.toLocaleString(locale), total: rep.newFiles.toLocaleString(locale) }) : t('stats.indexingList')}</span>
        )}
        {choices.length > 0 && (
          <label className="select st-copy" title={rep?.copies?.find((c) => c.id === copy)?.path}>
            <span className="dim small">{t('stats.copy')}</span>
            <select value={copy} onChange={(e) => pickCopy(e.target.value)} aria-label={t('stats.copy')}>
              <option value="">{t('stats.allCopies')}</option>
              {choices.map((c) => <option key={c.id} value={c.id}>{fam ? c.label : `${FAMILY_NAME[c.family] ?? c.family} · ${c.label}`}</option>)}
            </select>
          </label>
        )}
        {isNative && <button className="btn ghost sm" disabled={busy} onClick={() => { void load(false, true); }}>{busy ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />} {t('stats.reload')}</button>}
      </div>
      {!isNative && <p className="dim">{t('stats.preview')}</p>}
      {err && <p className="warn small">{err}</p>}
      {isNative && !rep && !err && <p className="dim"><Loader2 size={16} className="spin" /> {t('stats.reading')}</p>}
      {rep && rep.games.length === 0 && <section className="st-sec"><p className="dim">{rep.indexing ? t('stats.firstRun') : t('stats.empty')}</p></section>}
      {rep && view && rep.games.length > 0 && (
        <>
          <GameTiles games={rep.games} fam={fam} setFam={pickFam} />
          <Calendar runDays={view.runDays} days={view.days} />
          <div className="st-two">
            <MonthChart timeline={view.timeline} />
            <PlayChart days={view.days} since={since} />
          </div>
          <TopMaps maps={view.maps} />
          {view.maps.length > 0 && <MapTable maps={view.maps} fam={fam} />}
          <p className="dim small st-foot">{t('stats.noteCards', { since })} {t('stats.foot2', { files: rep.files, foreign: rep.foreign, dupes: rep.duplicates })}</p>
        </>
      )}
    </div>
  );
}
