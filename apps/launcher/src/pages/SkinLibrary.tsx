// Installed skins and mods per game (src-tauri/src/skinlib.rs): what sits in the folders ManiaPark downloads go
// to, with a preview from the zip, size, source (the ManiaPark asset when the launcher installed it), On/Off
// (moved to a folder the launcher owns, the game never reads it) and Remove (recycle bin). ManiaPark itself has
// no public API, so the store stays the embedded page (Skins page); this view is reached from its toolbar.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, ExternalLink, FolderOpen, LayoutGrid, List, Loader2, Palette, RefreshCw, Search, ShoppingBag, Trash2 } from 'lucide-react';
import { go, useHubState } from '../state';
import { backend, isNative, type SkinItem } from '../data/backend';
import { fmtSize, timeAgo } from '../data/model';
import { SAMPLE_INSTALLED_SKINS } from '../data/sample';
import { useT } from '../i18n';
import { Toggle } from '../ui/common';
import { goBack } from '../data/navHistory';
import '../styles-skinlib.css';

const SKIN_FAMILIES = new Set(['forever', 'maniaplanet', 'tm2020']);
const previews = new Map<string, Promise<string | null>>();

function readView(): 'tiles' | 'list' {
  try { return localStorage.getItem('tmhub.skinsView') === 'list' ? 'list' : 'tiles'; } catch { return 'tiles'; }
}

export function SkinLibrary({ initial }: { initial?: string }) {
  const hub = useHubState();
  const t = useT();
  const games = hub.games.filter((g) => SKIN_FAMILIES.has(g.family) && (g.installed || !isNative));
  const [game, setGame] = useState(() => [initial, hub.selectedGame].find((x) => games.some((g) => g.id === x)) ?? games[0]?.id ?? 'tmnf');
  const [items, setItems] = useState<SkinItem[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [kind, setKind] = useState<'all' | 'skin' | 'mod'>('all');
  const [q, setQ] = useState('');
  const [view, setViewState] = useState(readView);
  const setView = (v: 'tiles' | 'list') => { setViewState(v); try { localStorage.setItem('tmhub.skinsView', v); } catch { /* preview */ } };

  const reload = useCallback(() => {
    setError('');
    if (!backend.skins) { setItems(__PUBLIC_BUILD__ ? [] : structuredClone(SAMPLE_INSTALLED_SKINS)); return; }
    setItems(null);
    backend.skins.installed(game).then(setItems, (e) => { setItems([]); setError(String(e)); });
  }, [game]);
  useEffect(reload, [reload]);

  const rows = useMemo(() => {
    const ql = q.trim().toLowerCase();
    return (items ?? []).filter((i) => (kind === 'all' || i.kind === kind) && (!ql || i.name.toLowerCase().includes(ql) || i.folder.toLowerCase().includes(ql)));
  }, [items, kind, q]);
  const counts = { skin: items?.filter((i) => i.kind === 'skin').length ?? 0, mod: items?.filter((i) => i.kind === 'mod').length ?? 0 };

  const act = async (i: SkinItem, f: () => Promise<void>) => {
    setBusy(i.path);
    try { await f(); } catch (e) { hub.toast({ ok: false, message: String(e) }); }
    setBusy(null);
    reload();
  };
  const toggle = (i: SkinItem) => {
    if (!backend.skins) { setItems((list) => list?.map((x) => (x === i ? { ...x, enabled: !x.enabled } : x)) ?? null); return; }
    void act(i, () => backend.skins!.setEnabled(game, i.path, !i.enabled));
  };
  const remove = (i: SkinItem) => hub.setConfirm({
    title: t('skinlib.removeTitle'), text: t('skinlib.removeText', { name: i.name }), ok: t('common.remove'), cancel: t('common.cancel'),
    onOk: () => {
      if (!backend.skins) { setItems((list) => list?.filter((x) => x !== i) ?? null); return; }
      void act(i, () => backend.skins!.remove(game, i.path));
    },
  });
  const openPark = (i: SkinItem) => {
    if (!i.source) return;
    hub.setPendingWeb({ mode: 'skins', game, url: `https://maniapark.com/${i.source.parkType}/${i.source.parkId}` });
    go('skins', game);
  };

  return (
    <div className="page sl-page">
      <div className="page-head">
        <button className="btn ghost icon" onClick={() => goBack(() => go('skins', game))} title={t('common.back')} aria-label={t('common.back')}><ArrowLeft size={18} /></button>
        <div>
          <h1>{t('skinlib.title')}</h1>
          <span className="dim">{t('skinlib.sub')}</span>
        </div>
        <div className="grow" />
        <button className="btn primary" onClick={() => go('skins', game)}><ShoppingBag size={16} /> {t('skinlib.store')}</button>
      </div>

      <div className="toolbar">
        {games.length > 1 && (
          <label className="select">
            <span className="dim small">{t('skinlib.game')}</span>
            <select value={game} onChange={(e) => setGame(e.target.value)}>
              {games.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          </label>
        )}
        <div className="seg" role="radiogroup" aria-label={t('skinlib.kind')}>
          {(['all', 'skin', 'mod'] as const).map((k) => (
            <button key={k} role="radio" aria-checked={kind === k} className={kind === k ? 'on' : ''} onClick={() => setKind(k)}>
              {t('skinlib.kind.' + k)}{k !== 'all' && <span className="dim"> {counts[k]}</span>}
            </button>
          ))}
        </div>
        <label className="search grow"><Search size={16} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('skinlib.search')} aria-label={t('skinlib.search')} /></label>
        <button className="btn ghost icon" onClick={reload} title={t('skinlib.refresh')} aria-label={t('skinlib.refresh')}><RefreshCw size={16} /></button>
        <div className="seg layout-seg" role="radiogroup" aria-label={t('mods.layout')}>
          <button role="radio" aria-checked={view === 'tiles'} className={view === 'tiles' ? 'on' : ''} title={t('mods.layoutTiles')} onClick={() => setView('tiles')}><LayoutGrid size={15} /> {t('mods.layoutTiles')}</button>
          <button role="radio" aria-checked={view === 'list'} className={view === 'list' ? 'on' : ''} title={t('mods.layoutList')} onClick={() => setView('list')}><List size={15} /> {t('mods.layoutList')}</button>
        </div>
      </div>

      {error && <div className="small" style={{ color: "var(--danger)" }}>{error}</div>}
      {items === null && <div className="empty"><Loader2 size={18} className="spin" /></div>}
      {items && rows.length === 0 && (
        <div className="empty empty-rich">
          <Palette size={22} />
          <b>{items.length ? t('skinlib.noMatch') : t('skinlib.none')}</b>
          {!items.length && <button className="btn ghost sm" onClick={() => go('skins', game)}><ShoppingBag size={14} /> {t('skinlib.store')}</button>}
        </div>
      )}
      <div className={'modlist sl-list' + (view === 'list' ? ' as-list' : '')}>
        {rows.map((i) => (
          <div className={'modcard sl-card' + (i.enabled ? '' : ' off')} key={i.path}>
            <Preview game={game} item={i} />
            <div className="modcard-text">
              <div className="modcard-title">
                <b title={i.name}>{i.name.replace(/\.zip$/i, '')}</b>
                <span className="dim">{t('skinlib.kind.' + i.kind + 'One')} · {i.folder}</span>
              </div>
              <p className="dim small">{i.enabled ? t('skinlib.inFolder', { folder: i.dir.slice(Math.max(0, i.dir.toLowerCase().lastIndexOf('skins'))) }) : t('skinlib.offNote')}</p>
              <div className="modcard-tags">
                <span className="pill tiny">{fmtSize(i.size)}</span>
                {i.source
                  ? <button className="pill tiny sl-src" onClick={() => openPark(i)} title={t('skinlib.sourceTip')}><ExternalLink size={11} /> ManiaPark</button>
                  : <span className="pill tiny muted" title={t('skinlib.unknownTip')}>{t('skinlib.unknown')}</span>}
                {i.modified && <span className="dim small">{timeAgo(i.modified)}</span>}
              </div>
            </div>
            <div className="modcard-stats sl-actions">
              <span className="sl-toggle">
                <span className={'small ' + (i.enabled ? 'good' : 'dim')}>{i.enabled ? t('skinlib.on') : t('skinlib.off')}</span>
                <Toggle on={i.enabled} busy={busy === i.path} onChange={() => toggle(i)} label={t('skinlib.toggle', { name: i.name })} title={i.enabled ? t('skinlib.offTip') : t('skinlib.onTip')} />
              </span>
              <span className="sl-btns">
                {backend.reveal && <button className="btn ghost icon sm" onClick={() => backend.reveal?.(i.path)} title={t('common.folder')} aria-label={t('common.folder')}><FolderOpen size={14} /></button>}
                <button className="btn ghost icon sm danger" disabled={busy === i.path} onClick={() => remove(i)} title={t('skinlib.removeTip')} aria-label={t('common.remove')}><Trash2 size={14} /></button>
              </span>
            </div>
          </div>
        ))}
      </div>
      <p className="dim small foot-note">{t('skinlib.foot')}</p>
    </div>
  );
}

/** Picture from the zip (or folder), else a neutral tile with the kind's icon. */
function Preview({ game, item }: { game: string; item: SkinItem }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    if (!backend.skins) return;
    const key = `${game}|${item.path}|${item.size}|${item.modified}`;
    if (!previews.has(key)) previews.set(key, backend.skins.preview(game, item.path).catch(() => null));
    let live = true;
    previews.get(key)!.then((s) => { if (live) setSrc(s); });
    return () => { live = false; };
  }, [game, item.path, item.size, item.modified]);
  return src
    ? <img className="mod-icon sl-thumb" src={src} alt="" style={{ width: 88, height: 88 }} />
    : <span className={'mod-icon sl-thumb none ' + item.kind} style={{ width: 88, height: 88 }} aria-hidden><Palette size={26} /></span>;
}
