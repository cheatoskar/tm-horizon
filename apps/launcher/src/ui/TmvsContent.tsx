// TM Vibrant Shaders content on its mod page: presets, colour looks and resource packs. The list comes from an
// index (a GitHub repository or a folder on this PC); installing downloads the files, checks their SHA-256 and
// validates them (src-tauri/src/tmvscontent.rs) before anything is written to the folders TMVS reads.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, ClipboardPaste, FolderOpen, Gauge, RefreshCw, Search, Share2, Trash2, Download, ExternalLink } from 'lucide-react';
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { useT } from '../i18n';
import { isNative, backend } from '../data/backend';
import { useHubState } from '../state';
import { CachedImg, SectionHead } from './common';
import { Modal } from './Modal';
import builtinJson from '../data/tmvs-builtin.json';

export type ContentKind = 'preset' | 'lut' | 'pack';
interface FileRef { role: string; path: string; sha256: string }
interface Item {
  id: string; kind: ContentKind; name: string; author: string; description: string; tags: string[]; games: string[]; env?: string; example?: boolean;
  files: FileRef[]; preview?: string | null; previewLocal?: boolean;
}
interface Local { kind: ContentKind; name: string; target: string; file: string; picture: string | null; description: string; installedHere: boolean }
interface State { docs: string | null; dirs: { id: string; path: string; exists: boolean }[]; local: Local[] }
interface Outcome { target: string; ok: boolean; message: string }
interface Built { id: string; name: string; description: string; tags: string[]; load: number; image: string }

export const DEFAULT_SOURCE = 'https://raw.githubusercontent.com/cheatoskar/tmvs-presets/main/';
const PRESETS_REPO = 'https://github.com/cheatoskar/tmvs-presets';
const BUILTIN = builtinJson as Built[];
const SOURCE_KEY = 'tmhub.tmvs.source';
const FOREVER = ['tmnf', 'tmuf', 'tmn-eswc'];

const loadSource = () => { try { return localStorage.getItem(SOURCE_KEY) || DEFAULT_SOURCE; } catch { return DEFAULT_SOURCE; } };
const saveSource = (s: string) => { try { if (s === DEFAULT_SOURCE) localStorage.removeItem(SOURCE_KEY); else localStorage.setItem(SOURCE_KEY, s); } catch { /* per-viewer convenience only */ } };

export function familyOf(game: string): 'forever' | 'maniaplanet' | null {
  return FOREVER.includes(game) ? 'forever' : game === 'tm2' || game.startsWith('tm2-') ? 'maniaplanet' : null;
}

/** The GitHub issue that proposes a preset (nothing is uploaded; the two files are attached by hand). */
export function submissionIssueUrl(name: string, description: string): string {
  const body = [
    `Preset name: ${name}`,
    `Author: `,
    `Description: ${description}`,
    `Tags (day, night, rain, ...): `,
    `Games (tmnf, tmuf, tmn-eswc, tm2): `,
    '',
    `Attach "${name}.ini" and "${name}.jpg" (16:9 JPEG, up to 1 MB) to this issue.`,
    'I made this preset myself and allow it to be shared.',
  ].join('\n');
  return `${PRESETS_REPO}/issues/new?title=${encodeURIComponent('Preset: ' + name)}&body=${encodeURIComponent(body)}`;
}

function useContent(kind: ContentKind) {
  const [source, setSourceState] = useState(loadSource);
  const [items, setItems] = useState<Item[] | null>(null);
  const [skipped, setSkipped] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<State | null>(null);
  const reload = useCallback(() => {
    setItems(null); setError(null);
    invoke<{ items: Item[]; skipped: string[] }>('tmvs_content_index', { source })
      .then((r) => { setItems(r.items.filter((i) => i.kind === kind)); setSkipped(r.skipped); })
      .catch((e) => { setItems([]); setError(String(e)); });
  }, [source, kind]);
  const refreshState = useCallback(() => { invoke<State>('tmvs_content_state', { kind }).then(setState).catch(() => setState(null)); }, [kind]);
  useEffect(reload, [reload]);
  useEffect(refreshState, [refreshState]);
  const setSource = (s: string) => { saveSource(s); setSourceState(s || DEFAULT_SOURCE); };
  return { source, setSource, items, skipped, error, state, reload, refreshState };
}

function Dots({ n }: { n: number }) {
  const t = useT();
  return <span className="tmvs-dots" title={t('tmvs.load', { n })}><Gauge size={12} />{[1, 2, 3].map((i) => <i key={i} className={i <= n ? 'on' : ''} />)}</span>;
}

function Picture({ item, local }: { item: Item; local?: boolean }) {
  const fb = <span className="tmvs-nopic" />;
  if (!item.preview) return <div className="tmvs-pic">{fb}</div>;
  return <div className="tmvs-pic">{local || item.previewLocal ? <img src={convertFileSrc(item.preview)} alt="" loading="lazy" /> : <CachedImg url={item.preview} fallback={fb} />}</div>;
}

export function TmvsContent({ kind }: { kind: ContentKind }) {
  const t = useT();
  const hub = useHubState();
  const c = useContent(kind);
  const [q, setQ] = useState('');
  const [scope, setScope] = useState<'all' | 'builtin' | 'community' | 'installed'>('all');
  const [tag, setTag] = useState<string | null>(null);
  const [picked, setPicked] = useState<Item | null>(null);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [sourceText, setSourceText] = useState(c.source);
  const [paste, setPaste] = useState(false);
  const [share, setShare] = useState(false);
  const installedGames = hub.games.filter((g) => g.installed).map((g) => g.id);

  const localBy = useMemo(() => {
    const m = new Map<string, Local[]>();
    for (const l of c.state?.local ?? []) m.set(l.name.toLowerCase(), [...(m.get(l.name.toLowerCase()) ?? []), l]);
    return m;
  }, [c.state]);
  const hereOf = (name: string) => (localBy.get(name.toLowerCase()) ?? []).filter((l) => l.installedHere);

  const builtin = kind === 'preset' ? BUILTIN : [];
  const all = useMemo(() => {
    const comm = (c.items ?? []).map((i) => ({ ...i, source: 'community' as const }));
    const bi = builtin.map((b) => ({ id: 'builtin-' + b.id, kind: 'preset' as const, name: b.name, author: 'TM Vibrant Shaders', description: b.description, tags: b.tags, games: ['tmnf', 'tmuf', 'tmn-eswc', 'tm2'], files: [], preview: b.image, previewLocal: false, load: b.load, source: 'builtin' as const }));
    return [...bi, ...comm] as (Item & { source: 'builtin' | 'community'; load?: number })[];
  }, [c.items, builtin]);
  const tags = useMemo(() => [...new Set(all.flatMap((i) => i.tags))].sort(), [all]);
  const shown = all.filter((i) => {
    if (scope === 'builtin' && i.source !== 'builtin') return false;
    if (scope === 'community' && i.source !== 'community') return false;
    if (scope === 'installed' && !(i.source === 'community' && hereOf(i.name).length)) return false;
    if (tag && !i.tags.includes(tag)) return false;
    const s = q.trim().toLowerCase();
    return !s || [i.name, i.author, i.description, ...i.tags].some((x) => x.toLowerCase().includes(s));
  });

  if (!isNative) return <section className="panel"><p className="dim">{t('tmvs.onlyApp')}</p></section>;
  const kindWord = t('tmvs.tab.' + kind);
  const folder = c.state?.dirs[0];

  const remove = async (name: string) => {
    try {
      const r = await invoke<Outcome[]>('tmvs_content_remove', { kind, name, target: null });
      hub.toast({ message: [...new Set(r.map((o) => o.message))].join(' '), ok: r.every((o) => o.ok) });
    } catch (e) { hub.toast({ message: String(e), ok: false }); }
    c.refreshState();
  };

  return (
    <div className="tmvs-content">
      <section className="panel">
        <div className="tmvs-bar">
          <label className="tmvs-search"><Search size={15} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('tmvs.search')} aria-label={t('tmvs.search')} /></label>
          <div className="seg small-seg">
            {(['all', ...(kind === 'preset' ? ['builtin'] : []), 'community', 'installed'] as const).map((s) => (
              <button key={s} className={scope === s ? 'on' : ''} onClick={() => setScope(s as typeof scope)}>{t('tmvs.scope.' + s)}</button>
            ))}
          </div>
          <div className="grow" />
          {kind === 'preset' && <button className="btn ghost sm" title={t('tmvs.pasteTip')} onClick={() => setPaste(true)}><ClipboardPaste size={15} /> {t('tmvs.paste')}</button>}
          {kind === 'preset' && <button className="btn ghost sm" title={t('tmvs.shareTip')} onClick={() => setShare(true)}><Share2 size={15} /> {t('tmvs.share')}</button>}
          {folder && <button className="btn ghost sm" title={folder.path} onClick={() => backend.reveal?.(folder.path).then((r) => { if (!r.ok) hub.toast(r); })}><FolderOpen size={15} /> {t('tmvs.openFolder')}</button>}
          <button className="btn ghost sm" onClick={() => { setSourceText(c.source); setSourceOpen(!sourceOpen); }}>{t('tmvs.source')}</button>
        </div>
        {tags.length > 0 && (
          <div className="tmvs-tags">
            {tags.map((x) => <button key={x} className={'tmvs-tag' + (tag === x ? ' on' : '')} onClick={() => setTag(tag === x ? null : x)}>{x}</button>)}
          </div>
        )}
        {sourceOpen && (
          <div className="tmvs-source">
            <p className="dim small">{t('tmvs.sourceTip')}</p>
            <div className="row">
              <input className="grow" value={sourceText} onChange={(e) => setSourceText(e.target.value)} aria-label={t('tmvs.source')} spellCheck={false} />
              <button className="btn ghost sm" onClick={async () => { const p = await invoke<string | null>('tmvs_pick_folder').catch(() => null); if (p) setSourceText(p); }}>{t('tmvs.browse')}</button>
              <button className="btn primary sm" onClick={() => { c.setSource(sourceText.trim()); setSourceOpen(false); }}>{t('tmvs.use')}</button>
              <button className="btn ghost sm" onClick={() => { setSourceText(DEFAULT_SOURCE); c.setSource(DEFAULT_SOURCE); setSourceOpen(false); }}>{t('tmvs.default')}</button>
            </div>
          </div>
        )}
        {kind !== 'preset' && <p className="dim small tmvs-note">{t(kind === 'lut' ? 'tmvs.lutNote' : 'tmvs.packNote')}</p>}
        {c.error && (
          <div className="notice slim" role="status">
            <div className="small grow">{t('tmvs.offline', { url: c.source })}<br /><span className="dim">{c.error}</span></div>
            <button className="btn ghost sm" onClick={c.reload}><RefreshCw size={14} /> {t('tmvs.reload')}</button>
          </div>
        )}
        {c.skipped.length > 0 && <p className="dim small" title={c.skipped.join('\n')}>{t('tmvs.skipped', { n: c.skipped.length })}</p>}
      </section>

      {c.items === null && <p className="dim">{t('common.checking')}</p>}
      <div className="tmvs-grid" data-testid="tmvs-grid">
        {shown.map((i) => {
          const here = i.source === 'community' ? hereOf(i.name) : [];
          return (
            <article key={i.source + i.id} className="tmvs-card">
              <Picture item={i} />
              <div className="tmvs-body">
                <div className="tmvs-title">
                  <b title={i.name}>{i.name}</b>
                  {i.example && <span className="chip warn" title={t('tmvs.exampleTip')}>{t('tmvs.example')}</span>}
                  {i.source === 'builtin' && <span className="chip" title={t('tmvs.builtinTip')}>{t('tmvs.builtin')}</span>}
                  {here.length > 0 && <span className="chip ok"><Check size={11} /> {t('tmvs.installed')}</span>}
                </div>
                <div className="dim small">{i.author}{i.env ? ` · ${i.env}` : ''}</div>
                <p className="tmvs-desc">{i.description}</p>
                <div className="tmvs-meta">
                  {i.tags.slice(0, 4).map((x) => <span key={x} className="chip">{x}</span>)}
                  {i.load != null && <Dots n={i.load} />}
                </div>
                <div className="tmvs-actions">
                  {i.source === 'community' && !here.length && <button className="btn primary sm" onClick={() => setPicked(i)}><Download size={14} /> {t('tmvs.install')}</button>}
                  {i.source === 'community' && here.length > 0 && <button className="btn ghost sm" onClick={() => setPicked(i)}><RefreshCw size={14} /> {t('tmvs.update')}</button>}
                  {here.length > 0 && <button className="btn ghost sm" onClick={() => remove(i.name)}><Trash2 size={14} /> {t('tmvs.remove')}</button>}
                </div>
              </div>
            </article>
          );
        })}
      </div>
      {c.items !== null && shown.length === 0 && <p className="dim">{t('tmvs.empty')}</p>}

      {(c.state?.local ?? []).filter((l) => !l.installedHere).length > 0 && (
        <section className="panel">
          <SectionHead title={t('tmvs.mine', { what: kindWord })} />
          <ul className="tmvs-local">
            {c.state!.local.filter((l) => !l.installedHere).map((l) => (
              <li key={l.file}>
                <b>{l.name}</b> <span className="dim small">{l.target === 'maniaplanet' ? 'TM2' : 'Nations / United / ESWC'}{l.description ? ' · ' + l.description : ''}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {picked && <InstallDialog item={picked} source={c.source} installedGames={installedGames} onClose={(done) => { setPicked(null); if (done) c.refreshState(); }} />}
      {paste && <PasteDialog onClose={() => setPaste(false)} />}
      {share && <ShareDialog locals={(c.state?.local ?? []).filter((l) => l.kind === 'preset')} onClose={() => setShare(false)} />}
    </div>
  );
}

function InstallDialog({ item, source, installedGames, onClose }: { item: Item; source: string; installedGames: string[]; onClose: (done: boolean) => void }) {
  const t = useT();
  const hub = useHubState();
  const families = [...new Set(item.games.map(familyOf).filter(Boolean))] as ('forever' | 'maniaplanet')[];
  const has = (f: string) => installedGames.some((g) => familyOf(g) === f);
  const [sel, setSel] = useState<string[]>(() => { const on = families.filter(has); return on.length ? on : families; });
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      const r = await invoke<Outcome[]>('tmvs_content_install', { source, kind: item.kind, itemId: item.id, targets: sel });
      hub.toast({ message: [...new Set(r.map((o) => o.message))].join(' '), ok: r.every((o) => o.ok) });
      onClose(r.some((o) => o.ok));
    } catch (e) { hub.toast({ message: String(e), ok: false }); setBusy(false); }
  };
  return (
    <Modal title={t('tmvs.install') + ': ' + item.name} onClose={() => onClose(false)}
      actions={<><button className="btn ghost" onClick={() => onClose(false)}>{t('common.cancel')}</button><button className="btn primary" disabled={busy || sel.length === 0} onClick={run}><Download size={15} /> {busy ? t('tmvs.working') : t('tmvs.install')}</button></>}>
      <p className="dim small">{item.description}</p>
      <div className="side-block">
        <span className="dim small">{t('tmvs.installFor')}</span>
        {families.map((f) => (
          <label key={f} className="check"><input type="checkbox" checked={sel.includes(f)} onChange={(e) => setSel(e.target.checked ? [...sel, f] : sel.filter((x) => x !== f))} /> {t('tmvs.family.' + f)}{has(f) ? '' : <span className="dim small"> · {t('tmvs.notFound')}</span>}</label>
        ))}
      </div>
      <p className="dim small">{t('tmvs.safe')}</p>
    </Modal>
  );
}

function PasteDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const hub = useHubState();
  const [text, setText] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const check = async (value: string) => {
    setText(value); setCode(null);
    if (!value.trim()) { setErr(null); return; }
    try { setCode(await invoke<string>('tmvs_share_code', { text: value })); setErr(null); } catch (e) { setErr(String(e)); }
  };
  return (
    <Modal title={t('tmvs.paste')} onClose={onClose}
      actions={<><button className="btn ghost" onClick={onClose}>{t('common.cancel')}</button><button className="btn primary" disabled={!code} onClick={async () => { await navigator.clipboard?.writeText(code!).catch(() => {}); hub.toast({ message: t('tmvs.codeCopied') }); onClose(); }}>{t('tmvs.copyCode')}</button></>}>
      <p className="dim small">{t('tmvs.pasteHint')}</p>
      <textarea className="tmvs-code" rows={4} value={text} placeholder="TMVS1:…" onChange={(e) => check(e.target.value)} spellCheck={false} aria-label="TMVS1" />
      {err && <p className="small" style={{ color: 'var(--danger)' }}>{err}</p>}
      {code && <p className="small ok-text"><Check size={13} /> {t('tmvs.codeOk', { n: code.length })}</p>}
    </Modal>
  );
}

function ShareDialog({ locals, onClose }: { locals: Local[]; onClose: () => void }) {
  const t = useT();
  const hub = useHubState();
  const mine = locals.filter((l) => !l.installedHere);
  const [pick, setPick] = useState<Local | null>(mine[0] ?? null);
  const dir = (f: string) => f.replace(/[\\/][^\\/]*$/, '');
  return (
    <Modal title={t('tmvs.shareTitle')} onClose={onClose}
      actions={<><button className="btn ghost" onClick={onClose}>{t('common.close')}</button><button className="btn primary" disabled={!pick} onClick={() => { backend.openExternal(submissionIssueUrl(pick!.name, pick!.description)); hub.toast({ message: t('tmvs.issueOpened') }); }}><ExternalLink size={15} /> {t('tmvs.openIssue')}</button></>}>
      {mine.length === 0 && <p className="dim">{t('tmvs.shareNone')}</p>}
      {mine.length > 0 && (
        <>
          <p className="dim small">{t('tmvs.shareText')}</p>
          <select value={pick?.file ?? ''} onChange={(e) => setPick(mine.find((m) => m.file === e.target.value) ?? null)} aria-label={t('tmvs.shareTitle')}>
            {mine.map((m) => <option key={m.file} value={m.file}>{m.name}{m.target === 'maniaplanet' ? ' (TM2)' : ''}</option>)}
          </select>
          {pick && (
            <ul className="tmvs-files">
              <li><b>{pick.name}.ini</b><button className="btn ghost sm" onClick={() => backend.reveal?.(pick.file)}><FolderOpen size={14} /> {t('tmvs.show')}</button></li>
              <li><b>{pick.name}.jpg</b>{pick.picture ? <button className="btn ghost sm" onClick={() => backend.reveal?.(pick.picture!)}><FolderOpen size={14} /> {t('tmvs.show')}</button> : <span className="dim small">{t('tmvs.noPicture', { folder: dir(pick.file) })}</span>}</li>
            </ul>
          )}
        </>
      )}
    </Modal>
  );
}
