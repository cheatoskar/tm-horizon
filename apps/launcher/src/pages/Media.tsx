import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { Camera, ChevronLeft, ChevronRight, FileImage, FolderOpen, Image as ImageIcon, Play, RefreshCw, Trash2, Video, X } from 'lucide-react';
import { go, useHubState } from '../state';
import { backend, isNative } from '../data/backend';
import { fmtSize, timeAgo } from '../data/model';
import { readyThumb, requestThumb, thumbFailed } from '../data/thumbs';
import { tn, tp, useT } from '../i18n';
import '../styles-media.css';

interface Folder { game: string; kind: string; path: string; exists: boolean }
interface Item { path: string; name: string; kind: 'image' | 'video'; game: string; source: string; size: number; modified: string | null; folder: string; preview: boolean }
interface Listing { folders: Folder[]; items: Item[] }
interface DeleteResult { deleted: number; failed: { path: string; error: string }[] }

// Proper names, not translated.
const GAME_NAMES: Record<string, string> = {
  forever: 'TMNF / TMUF',
  maniaplanet: 'ManiaPlanet',
  tm2020: 'Trackmania',
  'tm-original': 'Original',
  'tm-sunrise': 'Sunrise',
  'tmn-eswc': 'Nations ESWC',
  'tm-2003': 'TrackMania (2003)',
};
const gameName = (g: string) => GAME_NAMES[g] ?? g;

type Kind = 'all' | 'image' | 'video';

// Grid geometry, matches styles-media.css: cards at least 300 px wide, 18 px apart, a 16:9
// picture, 8 px gap and a 38 px text line below it.
const MIN_COL = 300;
const GAP = 18;
const BELOW = 8 + 38;

function NoPreview({ name }: { name: string }) {
  return <span className="media-nopreview"><FileImage size={28} strokeWidth={1.4} /><span>{name.split('.').pop()?.toUpperCase()}</span></span>;
}

// Grid picture: a small JPEG made by the app (the originals are up to 11 MB each), loaded once the card is near the view.
function Thumb({ item }: { item: Item }) {
  const [src, setSrc] = useState(() => readyThumb(item));
  const [bad, setBad] = useState(() => thumbFailed(item));
  useEffect(() => {
    if (item.kind !== 'image' || src || bad) return;
    return requestThumb(item, false, setSrc, () => setBad(true));
  }, [item.path, item.size, item.modified]); // eslint-disable-line react-hooks/exhaustive-deps
  if (item.kind === 'video') return <video src={convertFileSrc(item.path) + '#t=0.5'} preload="metadata" muted playsInline tabIndex={-1} />;
  if (bad) return <NoPreview name={item.name} />;
  if (!src) return null;
  return <img src={src} alt="" decoding="async" draggable={false} />;
}

// Viewer picture: JPG/WebP and small PNGs as they are, BMP/TGA/large PNGs as a full-size JPEG copy
// (the app decides; the small picture shows meanwhile).
function ViewImage({ item }: { item: Item }) {
  const t = useT();
  const [src, setSrc] = useState(() => readyThumb(item, true));
  const [bad, setBad] = useState(false);
  useEffect(() => {
    if (src) return;
    return requestThumb(item, true, setSrc, () => setBad(true));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (bad) return <div className="media-nopreview big"><FileImage size={40} strokeWidth={1.4} /><span>{t('media.noPreview')}</span></div>;
  const small = readyThumb(item);
  if (!src) return small ? <img className="media-wait" src={small} alt={item.name} /> : <div className="media-nopreview big" />;
  return <img src={src} alt={item.name} />;
}

interface CardProps { item: Item; index: number; onOpen: (i: number, el: HTMLElement) => void; onRemove: (item: Item) => void }
const MediaCard = memo(function MediaCard({ item, index, onOpen, onRemove }: CardProps) {
  const t = useT();
  return (
    <div className="media-card">
      <button className="media-thumb" aria-label={t('media.open', { name: item.name })} onClick={(e) => onOpen(index, e.currentTarget)}>
        <Thumb item={item} />
        {item.kind === 'video' && <span className="media-play"><Play size={20} fill="currentColor" /></span>}
      </button>
      <div className="media-body">
        <div className="grow min0">
          <b className="ellip" title={item.name}>{item.name}</b>
          <div className="dim small ellip">{gameName(item.game)} · {timeAgo(item.modified)} · {fmtSize(item.size)}</div>
        </div>
        <button className="btn icon tiny" title={t('media.folderTip')} aria-label={t('media.folder')} onClick={() => backend.reveal?.(item.path)}><FolderOpen size={14} /></button>
        <button className="btn icon tiny" title={t('media.deleteTip')} aria-label={t('media.delete')} onClick={() => onRemove(item)}><Trash2 size={14} /></button>
      </div>
    </div>
  );
});

// Only the rows near the visible part of the page are in the DOM (the list can hold 2000 files).
function useGridWindow(count: number) {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const [win, setWin] = useState({ cols: 1, rowH: 0, first: 0, last: 0 });
  useLayoutEffect(() => {
    if (!el) return;
    const scroller = (el.closest('.main') as HTMLElement | null) ?? document.documentElement;
    let raf = 0;
    const measure = () => {
      raf = 0;
      const width = el.clientWidth;
      const cols = Math.max(1, Math.floor((width + GAP) / (MIN_COL + GAP)));
      const colW = (width - GAP * (cols - 1)) / cols;
      const rowH = Math.round((colW * 9) / 16 + BELOW + GAP);
      const top = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      const view = scroller.clientHeight;
      const over = view * 0.75;
      const first = Math.max(0, Math.floor((-top - over) / rowH));
      const last = Math.max(first, Math.ceil((-top + view + over) / rowH));
      setWin((w) => (w.cols === cols && w.rowH === rowH && w.first === first && w.last === last ? w : { cols, rowH, first, last }));
    };
    const on = () => { if (!raf) raf = requestAnimationFrame(measure); };
    measure();
    scroller.addEventListener('scroll', on, { passive: true });
    const ro = new ResizeObserver(on);
    ro.observe(el);
    ro.observe(scroller);
    return () => { scroller.removeEventListener('scroll', on); ro.disconnect(); if (raf) cancelAnimationFrame(raf); };
  }, [el, count]);
  return { setEl, el, ...win };
}

// Where the pictures and videos come from, and the mod that makes them.
function Sources() {
  const t = useT();
  return (
    <div className="media-src">
      <div className="media-src-item">
        <Camera size={18} />
        <div className="grow min0">
          <b>{t('media.src.shots')}</b>
          <span className="dim small">{t('media.src.shotsText')}</span>
        </div>
        <button className="btn ghost sm" onClick={() => go('mods', 'TM Vibrant Shaders')}>TM Vibrant Shaders</button>
      </div>
      <div className="media-src-item">
        <Video size={18} />
        <div className="grow min0">
          <b>{t('media.src.clips')}</b>
          <span className="dim small">{t('media.src.clipsText')}</span>
        </div>
        <button className="btn ghost sm" onClick={() => go('clips')}>{t('media.src.setup')}</button>
      </div>
    </div>
  );
}

export function Media() {
  const hub = useHubState();
  const t = useT();
  const [data, setData] = useState<Listing | null>(null);
  const [kind, setKind] = useState<Kind>('all');
  const [game, setGame] = useState('all');
  const [open, setOpen] = useState<number | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);

  const load = useCallback(() => {
    if (!isNative) return;
    invoke<Listing>('media_list').then(setData).catch((e) => hub.toast({ message: String(e), ok: false }));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(load, [load]);

  const games = useMemo(() => [...new Set((data?.items ?? []).map((i) => i.game))], [data]);
  useEffect(() => { if (game !== 'all' && data && !games.includes(game)) setGame('all'); }, [data, games, game]);
  const shown = useMemo(
    () => (data?.items ?? []).filter((i) => (kind === 'all' || i.kind === kind) && (game === 'all' || i.game === game)),
    [data, kind, game],
  );
  const current = open != null ? shown[open] : undefined;
  const grid = useGridWindow(shown.length);

  // Keep the lightbox on a valid item when the list shrinks.
  useEffect(() => { if (open != null && !shown[open]) setOpen(shown.length ? Math.min(open, shown.length - 1) : null); }, [shown, open]);

  const show = useCallback((i: number, el: HTMLElement) => { returnFocus.current = el; setOpen(i); }, []);
  const close = () => {
    // The card may have scrolled out of the DOM while stepping through the viewer: bring its row back first.
    const scroller = grid.el?.closest('.main') as HTMLElement | null;
    if (open != null && grid.el && scroller && grid.rowH) {
      const top = grid.el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop + Math.floor(open / grid.cols) * grid.rowH;
      if (top < scroller.scrollTop || top + grid.rowH > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = top - 80;
    }
    setOpen(null);
    if (returnFocus.current?.isConnected) returnFocus.current.focus();
  };
  const step = useCallback((d: number) => setOpen((i) => (i == null || !shown.length ? i : (i + d + shown.length) % shown.length)), [shown.length]);

  useEffect(() => {
    if (open == null || hub.confirm) return;
    const on = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); close(); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [open, hub.confirm, step]); // eslint-disable-line react-hooks/exhaustive-deps

  const remove = (item: Item) => {
    hub.setConfirm({
      title: t('media.confirmTitle'), ok: t('media.delete'),
      text: tn('media.confirmText', { name: <b className="mono">{item.name}</b> }),
      onOk: async () => {
        try {
          const r = await invoke<DeleteResult>('media_delete', { paths: [item.path] });
          if (r.failed.length) hub.toast({ message: t('media.deleteFailed', { error: r.failed[0].error }), ok: false });
          else hub.toast({ message: tp('media.deleted', r.deleted) });
        } catch (e) {
          hub.toast({ message: t('media.deleteFailed', { error: String(e) }), ok: false });
        }
        load();
      },
    });
  };
  // Cards are memoized: hand them a stable function that calls the current one.
  const removeRef = useRef(remove);
  removeRef.current = remove;
  const onRemove = useCallback((item: Item) => removeRef.current(item), []);

  const looked = data?.folders ?? [];
  const nothing = data && data.items.length === 0;
  const chips: [Kind, string][] = [['all', t('media.f.all')], ['image', t('media.f.shots')], ['video', t('media.f.clips')]];
  const rows = Math.ceil(shown.length / grid.cols);
  const from = grid.first * grid.cols;
  const to = Math.min(shown.length, (grid.last + 1) * grid.cols);

  return (
    <div className="page wide media-page">
      <div className="page-head">
        <div>
          <h1>{t('media.title')}</h1>
          <span className="dim">{!isNative ? t('media.previewHint') : data ? tp('media.count', shown.length) : t('media.loading')}</span>
        </div>
        <div className="grow" />
        {isNative && <button className="btn ghost" onClick={load}><RefreshCw size={16} /> {t('common.reload')}</button>}
      </div>

      <Sources />

      {isNative && data && !nothing && (
        <div className="toolbar media-tools">
          <div className="chips" role="group" aria-label={t('media.filterLabel')}>
            {chips.map(([id, label]) => (
              <button key={id} className={'fchip' + (kind === id ? ' on' : '')} aria-pressed={kind === id} onClick={() => setKind(id)}>{label}</button>
            ))}
          </div>
          {games.length > 1 && (
            <label className="select">
              <span className="dim small">{t('media.gameLabel')}</span>
              <select value={game} onChange={(e) => setGame(e.target.value)}>
                <option value="all">{t('media.game.all')}</option>
                {games.map((g) => <option key={g} value={g}>{gameName(g)}</option>)}
              </select>
            </label>
          )}
        </div>
      )}

      {nothing && (
        <div className="empty-state">
          <ImageIcon size={42} strokeWidth={1.4} />
          <b>{t('media.empty')}</b>
          <span className="dim">{t('media.emptyText')}</span>
          <ul className="media-looked">
            {looked.map((f) => <li key={f.kind + f.path} className="mono small dim">{f.path}</li>)}
          </ul>
        </div>
      )}
      {data && !nothing && shown.length === 0 && <div className="empty-state"><span className="dim">{t('media.emptyFilter')}</span></div>}

      {shown.length > 0 && (
        <div ref={grid.setEl} className="media-win" style={{ height: grid.rowH ? rows * grid.rowH - GAP : undefined }}>
          <div
            className="media-grid"
            style={grid.rowH ? { gridTemplateColumns: `repeat(${grid.cols}, minmax(0, 1fr))`, gridAutoRows: grid.rowH - GAP, transform: `translateY(${grid.first * grid.rowH}px)` } : undefined}
          >
            {shown.slice(from, to).map((it, k) => <MediaCard key={it.path} item={it} index={from + k} onOpen={show} onRemove={onRemove} />)}
          </div>
        </div>
      )}

      {current && (
        <div className="modal-bg" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
          <div className="media-box" role="dialog" aria-modal="true" aria-label={current.name}>
            <div className="player-head">
              <b className="ellip grow" title={current.name}>{current.name}</b>
              <span className="dim small">{t('media.position', { i: (open ?? 0) + 1, n: shown.length })}</span>
              <button className="btn ghost sm" onClick={() => backend.reveal?.(current.path)}><FolderOpen size={14} /> {t('media.folder')}</button>
              <button className="btn ghost sm" onClick={() => remove(current)}><Trash2 size={14} /> {t('media.delete')}</button>
              <button className="bbtn" autoFocus aria-label={t('media.close')} onClick={close}><X size={16} /></button>
            </div>
            <div className="media-stage">
              <button className="bbtn media-nav" aria-label={t('media.prev')} onClick={() => step(-1)}><ChevronLeft size={22} /></button>
              <div className="media-view">
                {current.kind === 'video'
                  ? <video key={current.path} src={convertFileSrc(current.path)} controls autoPlay />
                  : <ViewImage key={current.path} item={current} />}
              </div>
              <button className="bbtn media-nav" aria-label={t('media.next')} onClick={() => step(1)}><ChevronRight size={22} /></button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
