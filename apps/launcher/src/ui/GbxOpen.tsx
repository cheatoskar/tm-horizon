// The ".Gbx open with" dialog: a map or replay opened from Explorer (Settings > "Open .Gbx files with TM
// Horizon") or handed to TM Horizon on its command line. Shows what the file is, which game it is for,
// the installed copies of that game ("Open in <copy>" copies it into that copy's Downloaded folder and
// starts it like TMX Play), and "Statistics" for the map. Rust: gbxopen.rs, fileassoc.rs.
import { useEffect, useState } from 'react';
import { BarChart3, FileQuestion, FolderOpen, Loader2, Play } from 'lucide-react';
import { backend, isNative, type GbxAssocStatus, type GbxOpenInfo } from '../data/backend';
import { go, useHubState } from '../state';
import { useT } from '../i18n';
import { Modal } from './Modal';
import { Toggle } from './common';
import { stripTm } from '../data/tmformat.ts';
import { TmRich } from './hosting/TmPreview';
import { statsIntent } from '../data/statsView.ts';

const FAMILY: Record<string, string> = { tmnf: 'forever', tmuf: 'forever', 'tmn-eswc': 'tmn-eswc', 'tm-sunrise': 'tm-sunrise', 'tm-original': 'tm-original', tm2020: 'tm2020' };
const familyOf = (g: string) => FAMILY[g] ?? (g.startsWith('tm2-') || g === 'sm-storm' ? 'maniaplanet' : '');

/** "0:45.23" */
const fmt = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}.${String(Math.floor((ms % 1000) / 10)).padStart(2, '0')}`;

/** Mounted once (App.tsx): takes files from the launcher's start and from later double-clicks. */
export function GbxOpenHost() {
  const [queue, setQueue] = useState<string[]>([]);
  useEffect(() => {
    if (!isNative || !backend.gbxOpen) return;
    const first = backend.info?.().pendingFiles ?? [];
    if (first.length) setQueue((q) => [...q, ...first]);
    void backend.gbxOpen.takePending().then((l) => { if (l.length) setQueue((q) => [...q, ...l.filter((x) => !q.includes(x) && !first.includes(x))]); }).catch(() => undefined);
    return backend.on?.((e) => { if (e.type === 'openGbx') setQueue((q) => [...q, ...e.paths.filter((p) => !q.includes(p))]); });
  }, []);
  if (!queue.length) return null;
  return <GbxOpenDialog key={queue[0]} path={queue[0]} more={queue.length - 1} onClose={() => setQueue((q) => q.slice(1))} />;
}

export function GbxOpenDialog({ path, more, onClose }: { path: string; more: number; onClose: () => void }) {
  const t = useT();
  const hub = useHubState();
  const [info, setInfo] = useState<GbxOpenInfo | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  useEffect(() => {
    backend.gbxOpen?.info(path).then(setInfo).catch((e) => setErr(String(e)));
  }, [path]);
  const d = info?.detected;
  const gameName = (g: string) => hub.game(g)?.name ?? g;
  const open = async (c: GbxOpenInfo['choices'][number]) => {
    if (!backend.gbxOpen) return;
    setBusy(c.dir + c.game);
    const r = await backend.gbxOpen.openIn(path, c.game, c.dir, c.instance);
    setBusy('');
    hub.toast(r);
    if (r.ok) onClose();
  };
  const toStats = () => {
    if (!d) return;
    statsIntent.q = stripTm(d.name ?? '') || d.uid || '';
    go('stats', familyOf(d.games[0] ?? ''));
    onClose();
  };
  const best = d?.games[0];
  const choices = info?.choices ?? [];
  // Best guess first, the copy Play starts first inside each game.
  const sorted = [...choices].sort((a, b) => (d ? d.games.indexOf(a.game) - d.games.indexOf(b.game) : 0) || Number(b.main) - Number(a.main));
  return (
    <Modal wide title={<><FolderOpen size={18} /> {info?.file ?? path.split(/[\\/]/).pop()}</>} onClose={onClose}
      actions={<>
        {more > 0 && <span className="dim small grow">{t('gbxo.more', { n: more })}</span>}
        {d?.uid && <button className="btn ghost" onClick={toStats}><BarChart3 size={15} /> {t('nav.stats')}</button>}
        <button className="btn ghost" onClick={onClose}>{t('common.close')}</button>
      </>}>
      {!info && !err && <p className="dim"><Loader2 size={15} className="spin" /> {t('gbxo.reading')}</p>}
      {err && <p className="warn small"><FileQuestion size={14} /> {err}</p>}
      {d && (
        <div className="gbxo">
          <div className="gbxo-head">
            {d.thumbnail ? <img className="gbxo-thumb" src={d.thumbnail} alt="" /> : <span className="gbxo-thumb ph">{d.env ?? ''}</span>}
            <div className="gbxo-facts">
              <b className="gbxo-name">{d.name ? <TmRich text={d.name} safe /> : (d.uid ?? '–')}</b>
              <span className="dim small">{d.kind === 'replay' ? t('gbxo.replay') : t('gbxo.map')}{d.env ? ` · ${d.env}` : ''}{d.author ? ` · ${stripTm(d.author)}` : ''}{d.timeMs ? ` · ${fmt(d.timeMs)}` : ''}</span>
              <span className="small">{best ? t('gbxo.for', { game: d.games.map(gameName).join(', ') }) : t('gbxo.unknownGame')}</span>
            </div>
          </div>
          {best && !sorted.length && <p className="dim small">{t('gbxo.noCopy', { game: gameName(best) })}</p>}
          {sorted.length > 0 && (
            <div className="gbxo-list">
              {sorted.map((c) => (
                <div key={c.game + c.dir} className="gbxo-row">
                  <span className="grow min0">
                    <span><b>{gameName(c.game)}</b> <span className="dim small">· {c.label}{c.main ? ` · ${t('gbxo.main')}` : ''}</span></span>
                    <span className="dim small ellip gbxo-dir" title={c.dir}>{c.dir}</span>
                  </span>
                  <button className={'btn sm ' + (c.game === best && c.main ? 'primary' : 'ghost')} disabled={!!busy} onClick={() => { void open(c); }} title={t('gbxo.openTip')}>
                    {busy === c.dir + c.game ? <Loader2 size={14} className="spin" /> : <Play size={14} />} {t('gbxo.open')}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

/** Settings row "Open .Gbx files with TM Horizon": per-user association, off by default. Switching on says
 * what it replaces (asks first); switching off puts that back. */
export function GbxAssocSetting() {
  const t = useT();
  const hub = useHubState();
  const [s, setS] = useState<GbxAssocStatus | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { backend.gbxOpen?.assocStatus().then(setS).catch(() => setS(null)); }, []);
  if (!isNative || !backend.gbxOpen || !s) return null;
  const prog = s.current?.program ?? s.current?.name ?? s.current?.progid ?? null;
  const set = async (on: boolean) => {
    setBusy(true);
    try { setS(await backend.gbxOpen!.assocSet(on)); hub.toast({ ok: true, message: on ? t('gbxo.assocOn') : t('gbxo.assocOff') }); } catch (e) { hub.toast({ ok: false, message: String(e) }); }
    setBusy(false);
  };
  const flip = () => {
    if (s.on) { void set(false); return; }
    hub.setConfirm({ title: t('gbxo.assocTitle'), ok: t('gbxo.assocOk'), text: prog ? t('gbxo.assocReplaces', { program: prog }) : t('gbxo.assocNew'), onOk: () => { void set(true); } });
  };
  const note = s.on
    ? (prog ? t('gbxo.assocOnNote', { program: prog }) : t('gbxo.assocOnNoteNone'))
    : (prog ? t('gbxo.assocNow', { program: prog }) : t('gbxo.assocNoteNone'));
  return (
    <div className="setrow">
      <FolderOpen size={18} />
      <div className="grow">
        <b>{t('gbxo.assoc')}</b>
        <div className="dim small setnote">{note}</div>
        {s.on && s.userChoice && !s.userChoiceOurs && <div className="small warn setnote">{t('gbxo.userChoice')}</div>}
      </div>
      {busy ? <Loader2 size={16} className="spin" /> : <Toggle on={s.on} label={t('gbxo.assoc')} onChange={flip} />}
    </div>
  );
}
