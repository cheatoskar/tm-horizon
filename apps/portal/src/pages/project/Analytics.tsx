import { useMemo, useState } from 'react';
import type { DownloadStats, HubProject } from '@tm-hub/shared';
import { api } from '../../api.ts';
import { Async, useAsync } from '../../ui/common.tsx';
import { EmptyState, Section, Stat } from '../../ui/controls.tsx';
import { downloadsTip, fmtCount } from '../../ui/ProjectType.tsx';

const COLORS = ['#ff8a45', '#4d8dff', '#3ddc84', '#9d6bff', '#22c1b0', '#f2c14e', '#ff5468', '#9cc0ff'];

function dayList(days: number): string[] {
  const out: string[] = [];
  const end = new Date();
  for (let i = days - 1; i >= 0; i--) out.push(new Date(end.getTime() - i * 86400_000).toISOString().slice(0, 10));
  return out;
}

function Chart({ stats, days }: { stats: DownloadStats; days: number }) {
  const { list, versions, byDay, max } = useMemo(() => {
    const list = dayList(days);
    const versions = [...new Set(stats.days.map((d) => d.version))];
    const byDay = new Map<string, Map<string, number>>();
    for (const d of stats.days) {
      if (!byDay.has(d.day)) byDay.set(d.day, new Map());
      byDay.get(d.day)!.set(d.version, (byDay.get(d.day)!.get(d.version) ?? 0) + d.count);
    }
    let max = 1;
    for (const m of byDay.values()) max = Math.max(max, [...m.values()].reduce((a, b) => a + b, 0));
    return { list, versions, byDay, max };
  }, [stats, days]);
  const W = 800, H = 240, L = 40, B = 24, T = 8;
  const bw = (W - L) / list.length;
  const ph = H - B - T;
  const ticks = [0, 0.5, 1].map((f) => Math.round(max * f));
  return (
    <>
      <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Downloads per day">
        {ticks.map((t, ti) => {
          const y = T + ph - (t / max) * ph;
          return <g key={ti}><line x1={L} x2={W} y1={y} y2={y} style={{ stroke: 'var(--chart-grid)' }} /><text x={L - 6} y={y + 4} textAnchor="end" fontSize="11" style={{ fill: 'var(--chart-text)' }}>{t}</text></g>;
        })}
        {list.map((day, i) => {
          const m = byDay.get(day);
          let y = T + ph;
          const x = L + i * bw + Math.max(1, bw * 0.15);
          return (
            <g key={day}>
              <title>{day}: {m ? [...m.values()].reduce((a, b) => a + b, 0) : 0}</title>
              {m && versions.map((v, vi) => {
                const c = m.get(v);
                if (!c) return null;
                const h = (c / max) * ph;
                y -= h;
                return <rect key={v} x={x} y={y} width={Math.max(1, bw * 0.7)} height={h} fill={COLORS[vi % COLORS.length]}><title>{day} {v}: {c}</title></rect>;
              })}
              {(i === 0 || i === list.length - 1 || i % Math.ceil(list.length / 6) === 0) && <text x={x + bw * 0.35} y={H - 6} textAnchor="middle" fontSize="11" style={{ fill: 'var(--chart-text)' }}>{day.slice(5)}</text>}
            </g>
          );
        })}
      </svg>
      <div className="legend">{versions.map((v, i) => <span key={v}><i style={{ background: COLORS[i % COLORS.length] }} />{v}</span>)}</div>
    </>
  );
}

export function AnalyticsTab({ p }: { p: HubProject }) {
  const [days, setDays] = useState(30);
  const r = useAsync(() => api.stats(p.slug, days), [p.slug, days]);
  return (
    <Section title="Downloads" help="Total downloads add up TM Horizon installs and the downloads GitHub counts for your release files. The chart shows TM Horizon only."
      actions={<select style={{ width: 'auto' }} value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Range">
        <option value={7}>7 days</option><option value={30}>30 days</option><option value={90}>90 days</option><option value={365}>1 year</option>
      </select>}>
      <Async r={r}>
        {(s) => {
          const shown = s.days.reduce((a, d) => a + d.count, 0);
          const b = s.breakdown;
          return (
            <>
              <div className="stats">
                <Stat label="Total downloads" value={fmtCount(b.total)} tip={downloadsTip(b)} />
                <Stat label="TM Horizon" value={fmtCount(b.hub)} tip="Installs through the launcher and downloads from the project page. Each installation counts once a day." />
                <Stat label={b.github === null ? 'GitHub (no repository)' : 'GitHub'} value={b.github === null ? '–' : fmtCount(b.github)} tip="What GitHub counts for the zip and dll files of your releases. Read once a day." />
                <Stat label={`TM Horizon, last ${days} days`} value={fmtCount(shown)} />
              </div>
              {b.notCounted.length > 0 && <p className="hint">{b.notCounted.map((x) => (x === 'tmloader' ? 'TMLoader server' : 'Discord')).join(' and ')}: not counted. These sources publish no download numbers.</p>}
              {s.days.length === 0 ? <EmptyState title="No TM Horizon downloads in this range" text="Downloads show up here the day after the first install." /> : <Chart stats={s} days={days} />}
              {s.days.length > 0 && (
                <div className="tablewrap" style={{ marginTop: 'var(--tm-s-4)', maxHeight: 320, overflowY: 'auto' }}>
                  <table>
                    <thead><tr><th>Day</th><th>Version</th><th>Downloads</th></tr></thead>
                    <tbody>{[...s.days].reverse().map((d, i) => <tr key={i}><td>{d.day}</td><td>{d.version}</td><td>{d.count}</td></tr>)}</tbody>
                  </table>
                </div>
              )}
              <p className="hint" style={{ marginTop: 'var(--tm-s-3)', marginBottom: 0 }}>Daily totals only. No personal data is stored.</p>
            </>
          );
        }}
      </Async>
    </Section>
  );
}
