// "Verlauf": every change TM Horizon made to this game's folders (mod installs, updates, removals,
// Horizon Host, TMVS content, profile switches), newest first, each with Undo. Undo restores the
// files exactly and refuses when one of them changed since. Rust side: src-tauri/src/history.rs.
import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { ChevronDown, ChevronRight, History as HistoryIcon, Loader2, RotateCcw } from 'lucide-react';
import { backend, isNative } from '../data/backend';
import { CATALOG } from '../data/hub';
import { fmtDateTime, tp, tr, useT } from '../i18n';
import { useHubState } from '../state';
import { SectionHead } from './common';
import '../styles-history.css';

interface FileChange { path: string; before: string | null; after: string | null; size: number }
export interface ChangeView {
  id: string; at: string; games: string[]; kind: string; title: string; detail: string;
  files: FileChange[]; dirsCreated: string[]; undone: string | null; expired: boolean; incomplete: boolean;
  blocked: 'undone' | 'expired' | 'incomplete' | 'changed' | null; changed: string[];
}
interface UndoResult { ok: boolean; code: string; files: string[]; later: string[]; detail: string | null }

const KINDS = ['mod-install', 'mod-update', 'mod-remove', 'mod-restore', 'mod-rollback', 'mod-on', 'mod-off', 'mod-version', 'profile', 'pack',
  'host-install', 'host-remove', 'host-restore', 'host-plugin', 'host-plugin-remove', 'tmvs-install', 'tmvs-remove', 'openplanet', 'skid-clean', 'skid-classic', 'skid-tml', 'skid-tml-remove'];

const nice = (title: string) => CATALOG.find((c) => c.id === title)?.name ?? title;
const base = (p: string) => p.split(/[\\/]/).pop() ?? p;

/** One line: "TM Vibrant Shaders 1.4.2 installed". */
export function changeText(c: Pick<ChangeView, 'kind' | 'title' | 'detail'>): string {
  const key = KINDS.includes(c.kind) ? 'hist.k.' + c.kind : 'hist.k.other';
  return tr(key, { name: nice(c.title), detail: c.detail });
}

/** Message for a refused or failed undo. */
export function undoMessage(r: UndoResult): string {
  switch (r.code) {
    case 'changed': return r.later.length ? tr('hist.no.later', { list: r.later.map(nice).join(', ') }) : tr('hist.no.changed', { files: r.files.map(base).slice(0, 4).join(', ') });
    case 'running': return tr('hist.no.running', { exe: r.detail ?? '' });
    case 'expired': return tr('hist.no.expired');
    case 'incomplete': return tr('hist.no.incomplete');
    case 'undone': return tr('hist.no.undone');
    case 'missing': return tr('hist.no.missing');
    default: return tr('hist.no.error', { error: r.detail ?? '' });
  }
}

/** Common folder of the paths and each path relative to it (shown once instead of on every line). */
export function splitCommon(paths: string[]): { dir: string; rel: string[] } {
  const parts = paths.map((p) => p.split(/[\\/]/));
  let n = 0;
  const first = parts[0] ?? [];
  while (n < first.length - 1 && parts.every((x) => x.length - 1 > n && x[n].toLowerCase() === first[n].toLowerCase())) n++;
  const sep = paths[0]?.includes('\\') ? '\\' : '/';
  return { dir: first.slice(0, n).join(sep), rel: parts.map((x) => x.slice(n).join(sep)) };
}

/** "C:\Users\me\AppData\Local\TMLoader\database" -> "C:\…\TMLoader\database". */
function shortDir(d: string): string {
  const parts = d.split(/[\\/]/).filter(Boolean);
  const sep = d.includes('\\') ? '\\' : '/';
  return parts.length > 3 ? [parts[0], '…', ...parts.slice(-2)].join(sep) : d;
}

function mark(f: FileChange) {
  return f.before === null ? '+' : f.after === null ? '−' : '~';
}

function Row({ c, onUndo, busy }: { c: ChangeView; onUndo: (c: ChangeView) => void; busy: boolean }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const reason = c.blocked ? t('hist.why.' + c.blocked) : null;
  const common = splitCommon(c.files.map((f) => f.path));
  return (
    <li className={'hist-row' + (c.undone ? ' undone' : '')}>
      <button className="hist-toggle" aria-expanded={open} onClick={() => setOpen(!open)} aria-label={t('hist.files')}>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      </button>
      <div className="grow">
        <div className="hist-what">{changeText(c)}</div>
        <div className="dim small">{fmtDateTime(c.at)} · {tp('hist.nFiles', c.files.length)}{reason ? ' · ' + reason : ''}</div>
        {open && (
          <>
          {common.dir && <div className="dim small hist-dir" title={common.dir}>{t('hist.in', { dir: shortDir(common.dir) })}</div>}
          <ul className="hist-files mono small">
            {c.files.map((f, i) => (
              <li key={f.path} title={f.path} className={c.changed.includes(f.path) ? 'changed' : ''}>
                <span className={'hist-mark m' + mark(f)} aria-label={t(f.before === null ? 'hist.added' : f.after === null ? 'hist.deleted' : 'hist.replaced')}>{mark(f)}</span>
                <span className="hist-rel">{common.rel[i] || f.path}</span>
              </li>
            ))}
          </ul>
          </>
        )}
      </div>
      <button className="btn ghost sm" disabled={!!c.blocked || busy} title={reason ?? t('hist.undoTip')} onClick={() => onUndo(c)}>
        {busy ? <Loader2 size={14} className="spin" /> : <RotateCcw size={14} />} {t('hist.undo')}
      </button>
    </li>
  );
}

/** The list for one game (or all games with `game` empty). */
export function HistoryList({ game, limit = 6 }: { game?: string; limit?: number }) {
  const t = useT();
  const hub = useHubState();
  const [list, setList] = useState<ChangeView[] | null>(null);
  const [all, setAll] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(() => {
    invoke<ChangeView[]>('history_list', { game: game ?? null }).then(setList).catch(() => setList([]));
  }, [game]);
  useEffect(() => { if (isNative) load(); }, [load]);
  if (!isNative) return null;
  const undo = (c: ChangeView) => hub.setConfirm({
    title: t('hist.confirmTitle'), ok: t('hist.undo'), cancel: t('common.cancel'),
    text: t('hist.confirmText', { what: changeText(c), n: c.files.length }),
    onOk: async () => {
      setBusy(c.id);
      try {
        const r = await invoke<UndoResult>('history_undo', { id: c.id });
        hub.toast(r.ok ? { message: t('hist.done', { what: changeText(c) }) } : { message: undoMessage(r), ok: false });
        if (r.ok) void backend.rescan().catch(() => undefined);
      } catch (e) { hub.toast({ message: String(e), ok: false }); }
      setBusy(null);
      load();
    },
  });
  if (!list) return <p className="dim small"><Loader2 size={14} className="spin" /></p>;
  if (!list.length) return <p className="dim small">{t('hist.empty')}</p>;
  const shown = all ? list : list.slice(0, limit);
  return (
    <>
      <ul className="hist-list">{shown.map((c) => <Row key={c.id} c={c} onUndo={undo} busy={busy === c.id} />)}</ul>
      {list.length > limit && <button className="btn ghost sm" onClick={() => setAll(!all)}>{all ? t('hist.less') : t('hist.all', { n: list.length })}</button>}
    </>
  );
}

/** Game page card. */
export function HistoryCard({ game }: { game: string }) {
  const t = useT();
  if (!isNative) return null;
  return (
    <section className="panel" id="verlauf">
      <SectionHead title={t('hist.title')} sub={t('hist.sub')} right={<HistoryIcon size={16} className="dim" />} />
      <HistoryList game={game} />
    </section>
  );
}
