// Map step of the server wizard: sources on the left (my maps with folders, TMX ids/links/packs/
// searches, files), the server's playlist on the right (drag or Alt+arrows to reorder). Only real
// maps get in: the Rust side checks the GBX class (hosting/mapfiles.rs), replays never show up.
import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Check, FileUp, FolderOpen, GripVertical, ImageOff, Loader2, Plus, Search, Shuffle, Trash2, X } from 'lucide-react';
import { useT } from '../../i18n';
import { useHubState } from '../../state';
import { Toggle, useCachedImage } from '../common';
import { TmRich } from './TmPreview';
import { stripTm } from '../../data/tmformat';
import { errKey, fmtTime, host, type Kind, type MapMeta, type MapRef, type ServerDef, type TmxHit, type TmxPreview } from '../../data/hosting';

type SetFn = (p: Partial<ServerDef>) => void;
const keyOf = (m: MapRef) => (m.kind === 'file' ? 'f:' + m.path.toLowerCase() : 'tmx:' + m.id);

/** TMX picture of a map (same rule as hosting/tmx.rs thumb_url). */
export function tmxThumb(site: string | null, id: number): string | null {
  if (!site) return null;
  return /mania\.exchange$|^trackmania\.exchange$/.test(site) ? `https://${site}/mapthumb/${id}` : `https://${site}/trackshow/${id}/thumbnail`;
}

// Thumbnails embedded in map files, loaded once per path while the row is visible.
const thumbCache = new Map<string, Promise<string | null>>();
function useGbxThumb(path: string | null, wanted: boolean): string | null | undefined {
  const [src, setSrc] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    if (!path || !wanted) return;
    let live = true;
    let p = thumbCache.get(path);
    if (!p) { p = host.mapThumb(path).catch(() => null); thumbCache.set(path, p); }
    void p.then((s) => { if (live) setSrc(s); });
    return () => { live = false; };
  }, [path, wanted]);
  return path ? src : null;
}

function useVisible<T extends Element>(): [React.RefObject<T>, boolean] {
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    const el = ref.current;
    if (seen || !el) return;
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { setSeen(true); io.disconnect(); } }, { rootMargin: '200px' });
    io.observe(el);
    return () => io.disconnect();
  }, [seen]);
  return [ref, seen];
}

/** 48x48 picture: the map file's own thumbnail (stored upside down) or the TMX image. */
function Thumb({ path, url }: { path: string | null; url: string | null }) {
  const [ref, seen] = useVisible<HTMLSpanElement>();
  const gbx = useGbxThumb(path, seen);
  const useUrl = !path || gbx === null;
  const remote = useCachedImage(useUrl ? url : null, seen);
  const src = !useUrl ? gbx : remote;
  return (
    <span ref={ref} className="hm-thumb" aria-hidden>
      {src ? <img src={src} alt="" className={!useUrl ? 'flip' : ''} /> : src === null || (useUrl && !url) ? <ImageOff size={16} /> : null}
    </span>
  );
}

function Meta({ author, env, time, extra }: { author?: string; env?: string; time?: number | null; extra?: React.ReactNode }) {
  const parts = [author, env, fmtTime(time)].filter(Boolean);
  return <span className="hm-meta">{parts.map((p, i) => <span key={i}>{p}</span>)}{extra}</span>;
}

export function MapPicker({ d, set, kind }: { d: ServerDef; set: SetFn; kind: Kind }) {
  const t = useT();
  const hub = useHubState();
  const err = (e: unknown) => { const [k, x] = errKey(e); return t(k, { detail: x }); };
  const [q, setQ] = useState('');
  const [src, setSrc] = useState<'mine' | 'tmx'>('mine');
  const [local, setLocal] = useState<MapMeta[] | null>(null);
  const [folder, setFolder] = useState('');
  // facts about entries of the playlist we learnt on the way (picked files, TMX previews)
  const [known, setKnown] = useState<Record<string, { author?: string; env?: string; time?: number | null; path?: string | null; validated?: boolean; thumb?: string | null }>>({});
  const stunts = d.match.mode === 'stunts';

  useEffect(() => { host.localMaps(d.game).then(setLocal, () => setLocal([])); }, [d.game]);
  // header facts for what is on the list (files and downloaded TMX maps)
  const mapsKey = d.maps.map(keyOf).join('|');
  useEffect(() => {
    let live = true;
    const tm = setTimeout(() => {
      host.mapsMeta(d.id, d.game, d.maps).then((ms) => {
        if (!live) return;
        setKnown((k) => {
          const n = { ...k };
          d.maps.forEach((m, i) => { const x = ms[i]; if (x) n[keyOf(m)] = { ...n[keyOf(m)], author: x.author, env: x.environment, time: x.authorTime, path: x.path, validated: x.validated }; });
          return n;
        });
      }, () => undefined);
    }, 250);
    return () => { live = false; clearTimeout(tm); };
  }, [mapsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const chosen = useMemo(() => new Set(d.maps.map(keyOf)), [d.maps]);
  const ql = q.trim().toLowerCase();
  const match = (...s: (string | undefined)[]) => !ql || s.some((x) => x && stripTm(x).toLowerCase().includes(ql));

  const addFiles = (ms: MapMeta[]) => {
    const fresh = ms.filter((m) => !chosen.has('f:' + m.path.toLowerCase()));
    const ok = fresh.filter((m) => m.validated || stunts);
    if (ok.length < fresh.length) hub.toast({ message: t('hostmaps.skippedNotValidated', { n: fresh.length - ok.length }), ok: false });
    if (!ok.length) return;
    setKnown((k) => { const n = { ...k }; ok.forEach((m) => { n['f:' + m.path.toLowerCase()] = { author: m.author, env: m.environment, time: m.authorTime, path: m.path, validated: m.validated }; }); return n; });
    set({ maps: [...d.maps, ...ok.map((m) => ({ kind: 'file' as const, path: m.path, name: m.name }))] });
  };
  const remove = (k: string) => set({ maps: d.maps.filter((m) => keyOf(m) !== k) });
  const pickFiles = async () => {
    try {
      const r = await host.pickMaps();
      if (r.skipped.length) hub.toast({ message: t('hostmaps.skippedNotMaps', { n: r.skipped.length, names: r.skipped.slice(0, 3).join(', ') + (r.skipped.length > 3 ? ', …' : '') }), ok: false });
      addFiles(r.maps);
    } catch (e) { hub.toast({ message: err(e), ok: false }); }
  };

  const unvalidated = d.maps.filter((m) => known[keyOf(m)]?.validated === false).length;

  return (
    <div className="hm-wrap">
      <div className="hm-search">
        <Search size={15} aria-hidden />
        <input className="text-in" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('hostmaps.search')} aria-label={t('hostmaps.search')} />
        {q && <button type="button" className="bbtn" aria-label={t('hostmaps.clearSearch')} onClick={() => setQ('')}><X size={14} /></button>}
      </div>
      <div className="hm-panes">
        <section className="hm-pane" aria-label={t('hostmaps.sources')}>
          <div className="hm-pane-head">
            <div className="seg small-seg" role="tablist">
              <button role="tab" aria-selected={src === 'mine'} className={src === 'mine' ? 'on' : ''} onClick={() => setSrc('mine')}>{t('host.myMaps')}</button>
              <button role="tab" aria-selected={src === 'tmx'} className={src === 'tmx' ? 'on' : ''} onClick={() => setSrc('tmx')} disabled={!kind.tmx} title={kind.tmx ? undefined : t('host.noTmx')}>TMX</button>
            </div>
            <button type="button" className="btn ghost sm hm-files" onClick={pickFiles} title={t('hostmaps.filesHint')}><FileUp size={14} />{t('host.addFiles')}</button>
          </div>
          {src === 'mine'
            ? <MineList local={local} folder={folder} setFolder={setFolder} match={match} chosen={chosen} stunts={stunts} onAdd={addFiles} onRemove={remove} />
            : <TmxSource d={d} kind={kind} match={match} chosen={chosen}
                onAdded={(hits) => {
                  setKnown((k) => { const n = { ...k }; hits.forEach((h) => { n['tmx:' + h.id] = { ...n['tmx:' + h.id], author: h.author, env: h.environment, time: h.authorTime, thumb: h.thumb }; }); return n; });
                }} set={set} />}
        </section>

        <section className="hm-pane" aria-label={t('hostmaps.playlist')}>
          <div className="hm-pane-head">
            <b>{t('host.mapsChosen', { n: d.maps.length })}</b>
            <label className="hm-random"><Shuffle size={14} aria-hidden /><span>{t('host.randomOrder')}</span>
              <Toggle on={d.match.randomOrder} onChange={() => set({ match: { ...d.match, randomOrder: !d.match.randomOrder } })} label={t('host.randomOrder')} />
            </label>
          </div>
          {unvalidated > 0 && <div className="hm-warn small">{t('hostmaps.unvalidatedOnList', { n: unvalidated })}</div>}
          <Playlist d={d} set={set} kind={kind} known={known} match={match} remove={remove} />
        </section>
      </div>
    </div>
  );
}

/** Folder entries of the local list as a tree in a select ("Campaigns", "  Sub", ...). */
function folderTree(local: MapMeta[]): { path: string; depth: number; label: string; n: number }[] {
  const counts = new Map<string, number>();
  for (const m of local) {
    const parts = m.folder ? m.folder.split('/') : [];
    for (let i = 1; i <= parts.length; i++) { const p = parts.slice(0, i).join('/'); counts.set(p, (counts.get(p) ?? 0) + 1); }
  }
  return [...counts.keys()].sort((a, b) => a.localeCompare(b)).map((p) => ({ path: p, depth: p.split('/').length - 1, label: p.split('/').pop()!, n: counts.get(p)! }));
}

function MineList({ local, folder, setFolder, match, chosen, stunts, onAdd, onRemove }: {
  local: MapMeta[] | null; folder: string; setFolder: (f: string) => void; match: (...s: (string | undefined)[]) => boolean;
  chosen: Set<string>; stunts: boolean; onAdd: (m: MapMeta[]) => void; onRemove: (k: string) => void;
}) {
  const t = useT();
  const tree = useMemo(() => folderTree(local ?? []), [local]);
  const rows = (local ?? []).filter((m) => (!folder || m.folder === folder || m.folder.startsWith(folder + '/')) && match(m.name, m.author, m.folder));
  const addable = rows.filter((m) => !chosen.has('f:' + m.path.toLowerCase()) && (m.validated || stunts));
  return (
    <>
      <div className="hm-tools">
        <FolderOpen size={14} aria-hidden />
        <select className="text-in hm-folder" value={folder} onChange={(e) => setFolder(e.target.value)} aria-label={t('hostmaps.folder')}>
          <option value="">{t('hostmaps.allFolders', { n: local?.length ?? 0 })}</option>
          {tree.map((f) => <option key={f.path} value={f.path}>{'  '.repeat(f.depth) + (f.depth ? '└ ' : '') + f.label} ({f.n})</option>)}
        </select>
        <button type="button" className="btn ghost sm" disabled={!addable.length} onClick={() => onAdd(addable)}>
          <Plus size={14} />{t('hostmaps.addAll', { n: addable.length })}
        </button>
      </div>
      <ul className="hm-list" role="list">
        {local === null && <li className="dim small hm-empty"><Loader2 size={14} className="spin" /> {t('host.loading')}</li>}
        {local?.length === 0 && <li className="dim small hm-empty">{t('host.noLocalMaps')}</li>}
        {local !== null && local.length > 0 && rows.length === 0 && <li className="dim small hm-empty">{t('host.noHits')}</li>}
        {rows.slice(0, 400).map((m) => {
          const on = chosen.has('f:' + m.path.toLowerCase());
          const blocked = !m.validated && !stunts;
          return (
            <li key={m.path} className={'hm-row' + (on ? ' on' : '') + (blocked ? ' blocked' : '')}>
              <Thumb path={m.path} url={null} />
              <span className="hm-main">
                <span className="hm-name"><TmRich text={m.name} /></span>
                <Meta author={m.author} env={m.environment} time={m.authorTime} extra={<>
                  {m.folder && <span className="hm-folder-tag">{m.folder}</span>}
                  {!m.validated && <span className="pill tiny warn" title={t('hostmaps.notValidatedHint')}>{t('hostmaps.notValidated')}</span>}
                </>} />
              </span>
              <span className="pill tiny hm-badge">{t('hostmaps.badgeFile')}</span>
              {on
                ? <button type="button" className="bbtn hm-act" onClick={() => onRemove('f:' + m.path.toLowerCase())} aria-label={t('hostlist.remove')} title={t('hostlist.remove')}><Check size={14} /></button>
                : <button type="button" className="bbtn hm-act" disabled={blocked} onClick={() => onAdd([m])} aria-label={t('host.add')} title={blocked ? t('hostmaps.notValidatedHint') : t('host.add')}><Plus size={14} /></button>}
            </li>
          );
        })}
        {rows.length > 400 && <li className="dim small hm-empty">{t('hostmaps.more', { n: rows.length - 400 })}</li>}
      </ul>
    </>
  );
}

function TmxSource({ d, kind, match, chosen, onAdded, set }: {
  d: ServerDef; kind: Kind; match: (...s: (string | undefined)[]) => boolean; chosen: Set<string>;
  onAdded: (hits: TmxHit[]) => void; set: SetFn;
}) {
  const t = useT();
  const hub = useHubState();
  const [input, setInput] = useState('');
  const [asPack, setAsPack] = useState(false);
  const [busy, setBusy] = useState(false);
  const [prev, setPrev] = useState<TmxPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [prog, setProg] = useState<{ done: number; total: number } | null>(null);
  useEffect(() => host.onTmxProgress((p) => { if (p.id === d.id) setProg({ done: p.done, total: p.total }); }), [d.id]);
  const bare = /^\s*\d+\s*$/.test(input);
  const load = async () => {
    if (!input.trim()) return;
    setBusy(true); setError(null); setPrev(null);
    try {
      const p = await host.tmxPreview(d.game, bare && asPack ? 'pack:' + input.trim() : input);
      setPrev(p);
      setSel(new Set(p.hits.filter((h) => !chosen.has('tmx:' + h.id)).map((h) => h.id)));
    } catch (e) { const [k, x] = errKey(e); setError(t(k, { detail: x })); } finally { setBusy(false); }
  };
  const hits = (prev?.hits ?? []).filter((h) => match(h.name, h.author));
  const add = async (ids: number[]) => {
    if (!ids.length || !prev) return;
    setBusy(true); setProg({ done: 0, total: ids.length });
    try {
      const r = await host.tmxAdd(d.id, d.game, ids);
      const byId = new Map(prev.hits.map((h) => [h.id, h]));
      onAdded(r.added.map((a) => byId.get(a.id)!).filter(Boolean));
      const fresh = r.added.filter((a) => !chosen.has('tmx:' + a.id));
      set({ maps: [...d.maps, ...fresh.map((a) => ({ kind: 'tmx' as const, id: a.id, name: a.name || byId.get(a.id)?.name || `TMX ${a.id}` }))] });
      if (r.failed.length) {
        const [k, x] = errKey(r.failed[0].reason);
        hub.toast({ message: t('hostmaps.tmxFailed', { n: r.failed.length, detail: t(k, { detail: x }) }), ok: false });
      } else hub.toast({ message: t('hostmaps.tmxAdded', { n: r.added.length }), ok: true });
      setSel(new Set());
    } catch (e) { const [k, x] = errKey(e); hub.toast({ message: t(k, { detail: x }), ok: false }); } finally { setBusy(false); setProg(null); }
  };
  const allSel = hits.length > 0 && hits.every((h) => sel.has(h.id) || chosen.has('tmx:' + h.id));
  return (
    <>
      <form className="hm-tools" onSubmit={(e) => { e.preventDefault(); void load(); }}>
        <input className="text-in hm-grow" value={input} onChange={(e) => setInput(e.target.value)} placeholder={t('hostmaps.tmxPlaceholder')} aria-label={t('hostmaps.tmxPlaceholder')} spellCheck={false} />
        <button type="submit" className="btn ghost sm" disabled={busy || !input.trim()}>{busy && !prog ? <Loader2 size={14} className="spin" /> : <Search size={14} />}{t('hostmaps.tmxLoad')}</button>
      </form>
      <div className="hm-tmx-hint dim small">
        {bare && <label className="hm-check"><input type="checkbox" checked={asPack} onChange={(e) => setAsPack(e.target.checked)} /> {t('hostmaps.isPack')}</label>}
        <span>{t('hostmaps.tmxHint', { site: kind.tmx ?? '' })}</span>
      </div>
      {error && <div className="hs-error">{error}</div>}
      {prev && (
        <div className="hm-tools hm-prev-head">
          <span className="hm-grow small">
            {prev.kind === 'pack' ? <><b>{t('hostmaps.pack')}: <TmRich text={prev.title ?? ''} /></b>{prev.owner && <span className="dim"> · {prev.owner}</span>}</> : <b>{t('hostmaps.found')}</b>}
            <span className="dim"> · {t('hostmaps.count', { n: prev.hits.length })}{prev.more ? ' +' : ''}</span>
          </span>
          <label className="hm-check small"><input type="checkbox" checked={allSel} onChange={() => setSel(allSel ? new Set() : new Set(hits.filter((h) => !chosen.has('tmx:' + h.id)).map((h) => h.id)))} /> {t('hostmaps.all')}</label>
          <button type="button" className="btn primary sm" disabled={busy || sel.size === 0} onClick={() => add([...sel])}>
            {prog ? <><Loader2 size={14} className="spin" />{prog.done}/{prog.total}</> : <><Plus size={14} />{t('hostmaps.addN', { n: sel.size })}</>}
          </button>
        </div>
      )}
      {prog && <div className="hm-progress" role="progressbar" aria-valuemin={0} aria-valuemax={prog.total} aria-valuenow={prog.done}><span style={{ width: `${(100 * prog.done) / Math.max(1, prog.total)}%` }} /></div>}
      <ul className="hm-list" role="list">
        {!prev && !error && <li className="dim small hm-empty">{t('hostmaps.tmxEmpty')}</li>}
        {prev && hits.length === 0 && <li className="dim small hm-empty">{t('host.noHits')}</li>}
        {hits.map((h) => {
          const on = chosen.has('tmx:' + h.id);
          return (
            <li key={h.id} className={'hm-row' + (on ? ' on' : '')}>
              <input type="checkbox" className="hm-cb" checked={on || sel.has(h.id)} disabled={on || busy} aria-label={stripTm(h.name)}
                onChange={() => setSel((s) => { const n = new Set(s); if (n.has(h.id)) n.delete(h.id); else n.add(h.id); return n; })} />
              <Thumb path={null} url={h.thumb} />
              <span className="hm-main">
                <span className="hm-name"><TmRich text={h.name} /></span>
                <Meta author={h.author} env={h.environment} time={h.authorTime} />
              </span>
              <span className="pill tiny hm-badge tmx" title={`TMX ${h.id}`}>TMX</span>
              {on && <span className="hm-act hm-done" title={t('hostmaps.onList')}><Check size={14} /></span>}
            </li>
          );
        })}
      </ul>
    </>
  );
}

function Playlist({ d, set, kind, known, match, remove }: {
  d: ServerDef; set: SetFn; kind: Kind; known: Record<string, { author?: string; env?: string; time?: number | null; path?: string | null; validated?: boolean; thumb?: string | null }>;
  match: (...s: (string | undefined)[]) => boolean; remove: (k: string) => void;
}) {
  const t = useT();
  const [drag, setDrag] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const [sure, setSure] = useState(false);
  const listRef = useRef<HTMLUListElement>(null);
  const move = (from: number, to: number) => {
    if (from === to || to < 0 || to >= d.maps.length) return;
    const m = [...d.maps];
    const [x] = m.splice(from, 1);
    m.splice(to, 0, x);
    set({ maps: m });
    // keep keyboard focus on the moved row
    requestAnimationFrame(() => (listRef.current?.querySelectorAll<HTMLElement>('.hm-row')[to])?.focus());
  };
  return (
    <>
      <div className="hm-tools">
        <span className="dim small hm-grow">{t('hostmaps.reorderHint')}</span>
        {d.maps.length > 0 && (
          <button type="button" className="btn ghost sm danger" onClick={() => { if (sure) { setSure(false); set({ maps: [] }); } else setSure(true); }} onBlur={() => setSure(false)}>
            <Trash2 size={14} />{sure ? t('hostlist.sure') : t('hostmaps.removeAll')}
          </button>
        )}
      </div>
      <ul className="hm-list hm-playlist" role="list" ref={listRef}>
        {d.maps.length === 0 && <li className="dim small hm-empty">{t('hostmaps.emptyList')}</li>}
        {d.maps.map((m, i) => {
          const k = keyOf(m);
          const info = known[k] ?? {};
          if (!match(m.name, info.author)) return null;
          return (
            <li key={k} className={'hm-row' + (drag === i ? ' dragging' : '') + (over === i && drag !== null && drag !== i ? (drag < i ? ' drop-after' : ' drop-before') : '')}
              tabIndex={0} draggable
              aria-label={t('hostmaps.rowLabel', { n: i + 1, name: stripTm(m.name) })}
              onDragStart={(e) => { setDrag(i); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(i)); }}
              onDragOver={(e) => { if (drag !== null) { e.preventDefault(); setOver(i); } }}
              onDrop={(e) => { e.preventDefault(); if (drag !== null) move(drag, i); setDrag(null); setOver(null); }}
              onDragEnd={() => { setDrag(null); setOver(null); }}
              onKeyDown={(e) => {
                if (e.altKey && e.key === 'ArrowUp') { e.preventDefault(); move(i, i - 1); }
                else if (e.altKey && e.key === 'ArrowDown') { e.preventDefault(); move(i, i + 1); }
                else if (e.key === 'Delete') { e.preventDefault(); remove(k); }
              }}>
              <GripVertical size={14} className="hm-grip" aria-hidden />
              <span className="hm-idx">{i + 1}</span>
              <Thumb path={info.path ?? (m.kind === 'file' ? m.path : null)} url={m.kind === 'tmx' ? info.thumb ?? tmxThumb(kind.tmx, m.id) : null} />
              <span className="hm-main">
                <span className="hm-name"><TmRich text={m.name} /></span>
                <Meta author={info.author} env={info.env} time={info.time} extra={info.validated === false ? <span className="pill tiny warn" title={t('hostmaps.notValidatedHint')}>{t('hostmaps.notValidated')}</span> : null} />
              </span>
              <span className={'pill tiny hm-badge' + (m.kind === 'tmx' ? ' tmx' : '')} title={m.kind === 'tmx' ? `TMX ${m.id}` : m.path}>{m.kind === 'tmx' ? 'TMX' : t('hostmaps.badgeFile')}</span>
              <span className="hm-move">
                <button type="button" className="bbtn" disabled={i === 0} onClick={() => move(i, i - 1)} aria-label={t('hostmaps.up')} title={t('hostmaps.up')}><ArrowUp size={13} /></button>
                <button type="button" className="bbtn" disabled={i === d.maps.length - 1} onClick={() => move(i, i + 1)} aria-label={t('hostmaps.down')} title={t('hostmaps.down')}><ArrowDown size={13} /></button>
              </span>
              <button type="button" className="bbtn hm-x" onClick={() => remove(k)} aria-label={t('hostlist.remove')} title={t('hostlist.remove')}><X size={14} /></button>
            </li>
          );
        })}
      </ul>
    </>
  );
}
