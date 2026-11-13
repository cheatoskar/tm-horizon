// Map details: the 100tmx.com map inspector, natively (packages/map-inspector). Opens a local .Gbx offline:
// identity, medals and the medal check, the layout from above / by height / in build order / in 3D with
// build-order playback, the start/checkpoint/finish list and the block list with plotting. Reached from
// Statistics map rows, the map lists (Local maps here, downloads in the Maps shelf) and Map tools.
// CP and trigger display is fine here: it is outside the game, never an in-game overlay.
import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Box, FileSearch, FolderOpen, Loader2, MapPin, Pause, Play, RotateCcw, Search, SkipBack, SkipForward } from 'lucide-react';
import {
  buildGeometry, checkMedals, colourForNew, columnsUpTo, filterNames, formatTime, HEIGHT_RAMP, isoBlocksAt, ISO_KIND_COLOR, KIND_STYLE,
  ORDER_RAMP, PLOT_COLOR, PLOT_PALETTE, PLOT_PRESETS, RATES, routeCounts, type BlockKind, type Inspection, type Plotted,
} from '@tm-hub/map-inspector';
import { readGbxBytes, type GbxReadResult } from '@tm-hub/map-inspector/read';
import { FlatMap, Isometric3D, useBuildOrder } from '@tm-hub/map-inspector/react';
import { useHubState } from '../state';
import { backend, isNative, type LocalMapFile } from '../data/backend';
import { useT } from '../i18n';
import { TmText, stripTm } from '../ui/common';
import { goBack } from '../data/navHistory';
import { inspectMap, parseInspectArg, type InspectTarget } from '../ui/mapInspect';
import '../styles-mapinfo.css';

const KINDS: BlockKind[] = ['start', 'checkpoint', 'finish', 'multilap'];
/** Games whose maps can be listed (src-tauri/src/mapinspect.rs family_of). */
const MAP_FAMILIES = new Set(['forever', 'maniaplanet', 'tm2020', 'eswc', 'legacy']);

type Load = { state: 'idle' } | { state: 'busy' } | { state: 'error'; message: string } | { state: 'done'; result: GbxReadResult; path: string | null };

function useReadMessages() {
  const t = useT();
  return { tooSlow: t('mapinfo.err.slow'), notAMap: t('mapinfo.err.notMap'), failedToStart: t('mapinfo.err.reader') };
}

export function MapDetails({ arg }: { arg?: string }) {
  const t = useT();
  const messages = useReadMessages();
  const target = useMemo(() => parseInspectArg(arg), [arg]);
  const [load, setLoad] = useState<Load>({ state: 'idle' });

  useEffect(() => {
    if (!target) { setLoad({ state: 'idle' }); return; }
    let live = true;
    setLoad({ state: 'busy' });
    (async () => {
      const path = await resolvePath(target);
      if (!path) throw new Error(t('mapinfo.err.notFound'));
      if (!backend.mapBytes) throw new Error(t('mapinfo.err.native'));
      const result = await readGbxBytes(await backend.mapBytes(path), messages);
      if (live) setLoad({ state: 'done', result, path });
    })().catch((e) => { if (live) setLoad({ state: 'error', message: e instanceof Error ? e.message : String(e) }); });
    return () => { live = false; };
  }, [target]); // eslint-disable-line react-hooks/exhaustive-deps

  // Browser preview: a picked file is read right here (no backend for paths).
  const openFile = async (f: File) => {
    setLoad({ state: 'busy' });
    try { setLoad({ state: 'done', result: await readGbxBytes(await f.arrayBuffer(), messages), path: null }); }
    catch (e) { setLoad({ state: 'error', message: e instanceof Error ? e.message : String(e) }); }
  };

  return (
    <div className="page wide md-page">
      <div className="page-head">
        <button className="btn ghost icon" onClick={() => goBack(() => inspectMap())} title={t('common.back')} aria-label={t('common.back')}><ArrowLeft size={18} /></button>
        <div>
          <h1>{t('mapinfo.title')}</h1>
          <span className="dim">{t('mapinfo.sub')}</span>
        </div>
        <div className="grow" />
        <OpenButton onFile={openFile} />
      </div>
      {load.state === 'idle' && <LocalMaps />}
      {load.state === 'busy' && <div className="md-msg"><Loader2 size={18} className="spin" /> {t('mapinfo.reading')}</div>}
      {load.state === 'error' && (
        <div className="md-msg bad">
          <span>{load.message}</span>
          <button className="btn ghost sm" onClick={() => inspectMap()}>{t('mapinfo.localMaps')}</button>
        </div>
      )}
      {load.state === 'done' && <Result data={load.result.inspection} timedOut={load.result.layoutTimedOut} path={load.path} />}
    </div>
  );
}

async function resolvePath(t: InspectTarget): Promise<string | null> {
  if ('path' in t) return t.path;
  return backend.mapFind ? backend.mapFind(t.family, t.uid) : null;
}

/** "Open .Gbx…": the native file dialog, or a file input in the browser preview. */
function OpenButton({ onFile }: { onFile: (f: File) => void }) {
  const t = useT();
  const input = useRef<HTMLInputElement>(null);
  const pick = async () => {
    if (backend.gbxPick) { const p = await backend.gbxPick(); if (p) inspectMap({ path: p }); return; }
    input.current?.click();
  };
  return (
    <>
      <button className="btn primary" onClick={() => void pick()}><FileSearch size={16} /> {t('mapinfo.open')}</button>
      {!backend.gbxPick && <input ref={input} type="file" accept=".gbx" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ''; }} />}
    </>
  );
}

// ---------------------------------------------------------------- local maps

function LocalMaps() {
  const hub = useHubState();
  const t = useT();
  const games = hub.games.filter((g) => MAP_FAMILIES.has(g.family) && g.installed);
  const [game, setGame] = useState(() => (games.some((g) => g.id === hub.selectedGame) ? hub.selectedGame : games[0]?.id ?? 'tmnf'));
  const [maps, setMaps] = useState<LocalMapFile[] | null>(null);
  const [q, setQ] = useState('');
  const [limit, setLimit] = useState(200);
  useEffect(() => {
    if (!backend.mapList) { setMaps([]); return; }
    let live = true;
    setMaps(null);
    backend.mapList(game).then((m) => { if (live) setMaps(m); }, () => { if (live) setMaps([]); });
    return () => { live = false; };
  }, [game]);
  const rows = useMemo(() => {
    const ql = q.trim().toLowerCase();
    return (maps ?? []).filter((m) => !ql || stripTm(m.name).toLowerCase().includes(ql) || m.author.toLowerCase().includes(ql) || m.folder.toLowerCase().includes(ql));
  }, [maps, q]);
  return (
    <section className="panel md-local">
      <div className="md-head">
        <h2>{t('mapinfo.localMaps')}</h2>
        {maps && <span className="dim small">{rows.length}</span>}
        <div className="grow" />
        {games.length > 1 && (
          <label className="select">
            <span className="dim small">{t('mapinfo.game')}</span>
            <select value={game} onChange={(e) => setGame(e.target.value)}>
              {games.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          </label>
        )}
        <label className="search md-search"><Search size={15} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('mapinfo.search')} aria-label={t('mapinfo.search')} /></label>
      </div>
      {!isNative && <p className="dim small">{t('mapinfo.previewNote')}</p>}
      {maps === null && <div className="md-msg"><Loader2 size={16} className="spin" /> {t('mapinfo.loading')}</div>}
      {maps && rows.length === 0 && isNative && <div className="empty">{t('mapinfo.noMaps')}</div>}
      {rows.length > 0 && (
        <div className="md-table-wrap">
          <table className="md-table">
            <thead><tr><th>{t('mapinfo.map')}</th><th>{t('mapinfo.author')}</th><th>{t('mapinfo.env')}</th><th className="num">{t('mapinfo.authorTime')}</th><th>{t('mapinfo.folder')}</th><th /></tr></thead>
            <tbody>
              {rows.slice(0, limit).map((m) => (
                <tr key={m.path} onClick={() => inspectMap({ path: m.path })} className="md-row">
                  <td><TmText text={m.name} className="ellip" /></td>
                  <td className="dim ellip">{stripTm(m.author)}</td>
                  <td className="dim">{m.environment}</td>
                  <td className="num mono">{m.authorTime ? formatTime(m.authorTime) : '–'}</td>
                  <td className="dim ellip">{m.folder || '–'}</td>
                  <td className="num"><button className="btn ghost sm" onClick={(e) => { e.stopPropagation(); inspectMap({ path: m.path }); }}><FileSearch size={14} /> {t('mapinfo.inspect')}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {rows.length > limit && <button className="btn ghost sm md-more" onClick={() => setLimit(limit + 400)}>{t('mapinfo.more')}</button>}
    </section>
  );
}

// ---------------------------------------------------------------- result

const MEDALS = [
  ['author', '#3fb950'],
  ['gold', '#ffc83c'],
  ['silver', '#cecece'],
  ['bronze', '#cd7f32'],
] as const;

function Result({ data, timedOut, path }: { data: Inspection; timedOut: boolean; path: string | null }) {
  const t = useT();
  const s = data.summary;
  const counts = routeCounts(data.route);
  const medalValue = (k: (typeof MEDALS)[number][0]) => (k === 'author' ? s.authorTime : k === 'gold' ? s.gold : k === 'silver' ? s.silver : s.bronze);
  const checks = s.scoreKind === 'time' && s.authorTime ? checkMedals(s.authorTime, { gold: s.gold ?? undefined, silver: s.silver ?? undefined, bronze: s.bronze ?? undefined }) : [];
  const edited = checks.filter((c) => !c.ok);
  const [plotted, setPlotted] = useState<Plotted>(new Map());
  return (
    <>
      <section className="panel md-hero">
        {s.thumbnail ? <img className="md-thumb" src={`data:image/jpeg;base64,${s.thumbnail}`} alt="" /> : <div className="md-thumb none"><MapPin size={28} /></div>}
        <div className="md-hero-text">
          <h2><TmText text={s.name ?? t('mapinfo.untitled')} /></h2>
          {s.author && <span className="dim">{t('mapinfo.by', { name: stripTm(s.author) })}</span>}
          <div className="md-chips">
            {[s.environment, s.mood, s.mode ?? 'Race'].filter(Boolean).map((x) => <span key={x} className="pill">{x}</span>)}
            {s.isLapRace && <span className="pill">{t('mapinfo.laps', { n: s.laps ?? 1 })}</span>}
          </div>
          <div className="md-medals">
            {s.scoreKind === 'time'
              ? MEDALS.map(([k, c]) => (
                  <div key={k} className="md-medal">
                    <i style={{ background: c }} />
                    <span className="dim small">{t('mapinfo.medal.' + k)}</span>
                    <b className="mono">{medalValue(k) ? formatTime(medalValue(k)!) : '–'}</b>
                  </div>
                ))
              : <div className="md-medal"><i style={{ background: MEDALS[0][1] }} /><span className="dim small">{t(s.scoreKind === 'score' ? 'mapinfo.points' : 'mapinfo.respawns')}</span><b className="mono">{s.authorScore ?? '–'}</b></div>}
          </div>
          {checks.length > 0 && (edited.length === 0
            ? <span className="small good">{t('mapinfo.medalsOk')}</span>
            : <span className="small warn" title={t('mapinfo.medalsEditedTip')}>{t('mapinfo.medalsEdited', { list: edited.map((c) => `${t('mapinfo.medal.' + c.medal)} ${formatTime(c.actual)} ≠ ${formatTime(c.expected)}`).join(', ') })}</span>)}
        </div>
        <div className="md-hero-actions">
          {path && backend.reveal && <button className="btn ghost sm" onClick={() => backend.reveal?.(path)}><FolderOpen size={14} /> {t('common.folder')}</button>}
          <button className="btn ghost sm" onClick={() => inspectMap()}>{t('mapinfo.another')}</button>
        </div>
      </section>

      <div className="md-grid">
        <section className="panel md-facts">
          <h3>{t('mapinfo.facts')}</h3>
          <dl className="kv">
            <dt>{t('mapinfo.blocks')}</dt><dd>{s.blocks || '–'}</dd>
            <dt>{t('mapinfo.checkpoints')}</dt><dd>{counts.checkpoint ?? (data.hasLayout ? 0 : '–')}{s.checkpointsDeclared != null && data.hasLayout && s.checkpointsDeclared !== (counts.checkpoint ?? 0) ? <span className="warn small"> · {t('mapinfo.cpHeader', { n: s.checkpointsDeclared })}</span> : null}</dd>
            {s.size && <><dt>{t('mapinfo.size')}</dt><dd>{s.size.x} × {s.size.y} × {s.size.z}</dd></>}
            {s.vehicleMismatch && <><dt>{t('mapinfo.car')}</dt><dd className="warn">{s.vehicleMismatch.vehicle}</dd></>}
            <dt>{t('mapinfo.uid')}</dt><dd className="mono small md-uid">{s.uid ?? '–'}</dd>
          </dl>
          {s.comments && <><h3>{t('mapinfo.comments')}</h3><p className="md-comments"><TmText text={s.comments} /></p></>}
        </section>
        <RouteList data={data} />
      </div>

      <section className="panel md-view">
        {data.hasLayout
          ? <MapView data={data} plotted={plotted} />
          : <div className="md-msg">{t(timedOut ? 'mapinfo.noLayout' : 'mapinfo.noBlocks')}</div>}
      </section>
      {data.names.length > 0 && <BlockList data={data} plotted={plotted} onChange={setPlotted} />}
    </>
  );
}

function RouteList({ data }: { data: Inspection }) {
  const t = useT();
  const counts = routeCounts(data.route);
  return (
    <section className="panel md-route">
      <div className="md-head">
        <h3>{t('mapinfo.route')}</h3>
        <div className="grow" />
        {KINDS.filter((k) => counts[k]).map((k) => <span key={k} className="md-key"><i style={{ background: KIND_STYLE[k].color }} />{t('mapinfo.kind.' + k)} <b>{counts[k]}</b></span>)}
      </div>
      {data.route.length === 0
        ? <div className="dim small">{t('mapinfo.noRoute')}</div>
        : (
          <div className="md-table-wrap md-route-list">
            <table className="md-table">
              <thead><tr><th>#</th><th>{t('mapinfo.kind')}</th><th className="num">X</th><th className="num">Y</th><th className="num">Z</th><th>{t('mapinfo.facing')}</th></tr></thead>
              <tbody>
                {data.route.map((b, i) => (
                  <tr key={i}>
                    <td className="dim">{i + 1}</td>
                    <td><span className="md-key"><i style={{ background: KIND_STYLE[b.kind].color }} />{t('mapinfo.kind.' + b.kind)}</span></td>
                    <td className="num mono">{b.x}</td><td className="num mono">{b.y}</td><td className="num mono">{b.z}</td>
                    <td className="dim">{b.direction ? t('mapinfo.dir.' + b.direction) : '–'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
    </section>
  );
}

type View = 'track' | 'height' | 'order' | 'iso';

function MapView({ data, plotted }: { data: Inspection; plotted: Plotted }) {
  const t = useT();
  const [view, setView] = useState<View>('iso');
  const [ghost, setGhost] = useState(false);
  const [byOrder, setByOrder] = useState(false);
  const [triggers, setTriggers] = useState(true);
  const g = useMemo(() => buildGeometry(data, plotted), [data, plotted]);
  const total = g?.ordered ? g.isoBlocks.length : 0;
  const order = useBuildOrder(total, data);
  const iso = useMemo(() => (g ? isoBlocksAt(g, order.shown, byOrder) : []), [g, order.shown, byOrder]);
  const cells = useMemo(() => (g?.ordered ? columnsUpTo(g, order.shown) : []), [g, order.shown]);
  if (!g) return <div className="md-msg">{t('mapinfo.noBlocks')}</div>;
  const canOrder = g.ordered && total > 1;
  const newest = order.stepping && order.shown > 0 ? data.solid[order.shown - 1] : null;
  const kindLabel = (k: BlockKind) => t('mapinfo.kind.' + k);
  const views: [View, string][] = [['iso', t('mapinfo.view.iso')], ['track', t('mapinfo.view.track')], ['height', t('mapinfo.view.height')], ...(canOrder ? [['order', t('mapinfo.view.order')] as [View, string]] : [])];
  return (
    <>
      <div className="md-head">
        <h3>{t('mapinfo.layout')}</h3>
        <div className="seg" role="radiogroup" aria-label={t('mapinfo.layout')}>
          {views.map(([id, label]) => <button key={id} role="radio" aria-checked={view === id} className={view === id ? 'on' : ''} onClick={() => setView(id)}>{label}</button>)}
        </div>
        <div className="grow" />
        {view === 'iso' && <label className="md-check"><input type="checkbox" checked={ghost} onChange={(e) => setGhost(e.target.checked)} /> {t('mapinfo.ghost')}</label>}
        {view === 'iso' && canOrder && <label className="md-check"><input type="checkbox" checked={byOrder} onChange={(e) => setByOrder(e.target.checked)} /> {t('mapinfo.byOrder')}</label>}
        {g.triggerBoxes.length > 0 && <label className="md-check"><input type="checkbox" checked={triggers} onChange={(e) => setTriggers(e.target.checked)} /> {t('mapinfo.triggers')}</label>}
      </div>
      <div className="md-canvas">
        {view === 'iso'
          ? <Isometric3D ghost={ghost} height={520} buttonClassName="btn ghost sm" resetLabel={t('mapinfo.resetView')} ariaLabel={t('mapinfo.isoAria')}
              input={{ w: g.w, h: g.h, minY: g.minY, maxY: g.maxY, blocks: iso, ramp: HEIGHT_RAMP, triggers: triggers ? g.triggerBoxes : [] }} />
          : <div className="md-flat"><FlatMap g={g} colour={view === 'order' ? 'order' : view} showTriggers={triggers} kindLabel={kindLabel} frame="rgba(255,255,255,.12)"
              label={t('mapinfo.view.' + view)}
              order={view === 'order' ? { cells, shown: order.shown, total, newest: order.stepping ? (g.isoBlocks[order.shown - 1] ?? null) : null } : null} /></div>}
      </div>
      {canOrder && (view === 'order' || view === 'iso') && (
        <div className="md-scrub">
          <button className="btn primary sm" onClick={order.toggle}>{order.playing ? <Pause size={14} /> : <Play size={14} />} {order.playing ? t('mapinfo.pause') : order.shown >= total ? t('mapinfo.build') : t('mapinfo.play')}</button>
          <button className="btn ghost icon sm" aria-label={t('mapinfo.stepBack')} title={t('mapinfo.stepBack')} disabled={order.shown <= 0} onClick={() => order.seek(order.shown - 1)}><SkipBack size={14} /></button>
          <button className="btn ghost icon sm" aria-label={t('mapinfo.stepFwd')} title={t('mapinfo.stepFwd')} disabled={order.shown >= total} onClick={() => order.seek(order.shown + 1)}><SkipForward size={14} /></button>
          <input type="range" min={0} max={total} value={order.shown} onChange={(e) => order.seek(Number(e.target.value))} aria-label={t('mapinfo.buildOrder')} />
          <span className="mono small">{order.shown} / {total}</span>
          <select className="md-rate" value={order.rate} onChange={(e) => order.setRate(Number(e.target.value))} aria-label={t('mapinfo.speed')}>
            {RATES.map((r) => <option key={r} value={r}>{t('mapinfo.rate', { n: r })}</option>)}
          </select>
          {order.stepping && <button className="btn ghost icon sm" title={t('mapinfo.showAll')} aria-label={t('mapinfo.showAll')} onClick={() => order.seek(total)}><RotateCcw size={14} /></button>}
        </div>
      )}
      <div className="md-legend">
        {canOrder && (view === 'order' || (view === 'iso' && byOrder))
          ? <span className="md-key">{t('mapinfo.first')}<i className="md-ramp" style={{ background: `linear-gradient(to right, ${ORDER_RAMP.join(', ')})` }} />{t('mapinfo.last')}</span>
          : view === 'height'
            ? <span className="md-key">{g.minY}<i className="md-ramp" style={{ background: `linear-gradient(to right, ${HEIGHT_RAMP.join(', ')})` }} />{g.maxY} · {t('mapinfo.heightKey')}</span>
            : KINDS.filter((k) => data.route.some((b) => b.kind === k)).map((k) => <span key={k} className="md-key"><i style={{ background: view === 'iso' ? ISO_KIND_COLOR[k] : KIND_STYLE[k].color }} />{t('mapinfo.kind.' + k)}</span>)}
        {[...plotted].map(([name, c]) => <span key={name} className="md-key"><i className="sq" style={{ background: c }} /><span className="mono">{name}</span></span>)}
        <span className="grow" />
        <span className="dim small">{newest ? t('mapinfo.newest', { n: order.shown, name: newest.name, pos: `${newest.x}, ${newest.y}, ${newest.z}` }) : view === 'iso' ? t('mapinfo.isoHelp') : view === 'order' ? t('mapinfo.orderHelp') : t('mapinfo.northUp')}</span>
      </div>
    </>
  );
}

function BlockList({ data, plotted, onChange }: { data: Inspection; plotted: Plotted; onChange: (p: Plotted) => void }) {
  const t = useT();
  const [filter, setFilter] = useState('');
  const [brush, setBrush] = useState<string>(PLOT_COLOR);
  const shown = useMemo(() => filterNames(data.names, filter), [data.names, filter]);
  const toggle = (name: string) => {
    const next = new Map(plotted);
    if (next.has(name)) next.delete(name); else next.set(name, colourForNew(plotted, brush));
    onChange(next);
  };
  const plotAll = () => {
    const next = new Map(plotted);
    const c = colourForNew(plotted, brush);
    for (const n of shown) if (!next.has(n.name)) next.set(n.name, c);
    onChange(next);
  };
  return (
    <section className="panel md-blocks">
      <div className="md-head">
        <h3>{t('mapinfo.blockList')}</h3>
        <span className="dim small">{t('mapinfo.kinds', { n: data.names.length })}</span>
        <div className="grow" />
        <div className="md-swatches" role="radiogroup" aria-label={t('mapinfo.colour')}>
          {PLOT_PALETTE.map((c) => <button key={c.hex} role="radio" aria-checked={brush === c.hex} aria-label={c.name} title={c.name} className={'md-swatch' + (brush === c.hex ? ' on' : '')} style={{ background: c.hex }} onClick={() => setBrush(c.hex)} />)}
        </div>
      </div>
      <div className="md-head">
        {PLOT_PRESETS.map((p) => <button key={p.id} className={'coll-chip' + (filter === p.match ? ' on' : '')} onClick={() => setFilter(filter === p.match ? '' : p.match)}>{t('mapinfo.preset.' + p.id)}</button>)}
        <div className="grow" />
        <label className="search md-search"><Box size={15} /><input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={t('mapinfo.blockSearch')} aria-label={t('mapinfo.blockSearch')} /></label>
        {shown.length > 0 && shown.length < data.names.length && <button className="btn ghost sm" onClick={plotAll}>{t('mapinfo.plotAll', { n: shown.length })}</button>}
        {plotted.size > 0 && <button className="btn ghost sm" onClick={() => onChange(new Map())}>{t('mapinfo.clear')}</button>}
      </div>
      <ul className="md-names">
        {shown.length === 0 && <li className="dim small">{t('mapinfo.noBlockMatch')}</li>}
        {shown.map((n) => {
          const c = plotted.get(n.name);
          return (
            <li key={n.name}>
              <button className={'md-name' + (c ? ' on' : '')} aria-pressed={Boolean(c)} onClick={() => toggle(n.name)} title={t('mapinfo.plotTip')}>
                <i style={c ? { background: c, borderColor: c } : undefined} />
                <span className="mono ellip">{n.name}</span>
                <b>{n.count}</b>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
