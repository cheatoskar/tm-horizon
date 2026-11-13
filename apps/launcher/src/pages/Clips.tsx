import { useEffect, useState } from 'react';
import { toBody } from '../ui/Modal';
import { Check, Clapperboard, FolderOpen, Loader2, Play, RefreshCw, X } from 'lucide-react';
import { tmlName, useHubState } from '../state';
import { backend, isNative, type Clip } from '../data/backend';
import { fmtSize, timeAgo } from '../data/model';
import { tn, tp, useT } from '../i18n';

const CLIPS_DIR = 'Documents\\TrackMania\\Clips';
const RECORDERS = ['TM Clips', 'TM Vibrant Shaders'];

// Which Forever games can record: TM Clips or TM Vibrant Shaders ticked in the game's current profile.
function RecordingCard() {
  const hub = useHubState();
  const t = useT();
  const rows = ['tmnf', 'tmuf'].filter((id) => hub.games.find((g) => g.id === id)?.installed).map((id) => {
    const game = hub.game(id);
    const profile = hub.profileFor(id);
    const active = RECORDERS.find((r) => profile?.mods.some((m) => m.id === r));
    const installed = RECORDERS.find((r) => hub.mods.find((m) => m.id === r)?.installedVersions.length);
    const installable = RECORDERS.find((r) => hub.mods.find((m) => m.id === r)?.latest);
    return { game, profile, active, installed, installable };
  });
  const install = async (mod: string, profileName: string) => {
    const m = hub.mods.find((x) => x.id === mod);
    if (!m) return;
    hub.setBusy((b) => ({ ...b, ['mod:' + mod]: 'download' }));
    const r = await backend.installMod(mod, m.latest ?? '', profileName, true);
    hub.setBusy((b) => { const n = { ...b }; delete n['mod:' + mod]; return n; });
    hub.toast(r);
  };
  return (
    <section className="panel rec-card">
      <div>
        <h2>{t('clips.rec.title')}</h2>
        <span className="dim small">{t('clips.rec.sub')}</span>
      </div>
      <div className="rec-rows">
        {rows.length === 0 && <span className="dim small">{t('clips.rec.noGame')}</span>}
        {rows.map(({ game, profile, active, installed, installable }) => {
          const pname = tmlName(profile);
          const target = installed ?? installable;
          const busy = target && hub.busy['mod:' + target];
          return (
            <div className="rec-row" key={game.id}>
              <div className="rec-state">
                <b>{game.name}</b>
                {active
                  ? <span className="ok-text"><Check size={13} /> {t('clips.rec.active', { profile: profile!.name, mod: active })}</span>
                  : !pname
                    ? <span className="dim small">{t('clips.rec.noProfile')}</span>
                    : installed
                      ? <span className="dim small">{t('clips.rec.off', { mod: installed, profile: profile!.name })}</span>
                      : <span className="dim small">{t('clips.rec.missing')}</span>}
              </div>
              {!active && pname && installed && <button className="btn primary sm" onClick={() => hub.toggleMod(profile!.id, installed)}>{t('clips.rec.turnOn', { profile: profile!.name })}</button>}
              {!active && pname && !installed && target && (busy
                ? <span className="btn ghost sm disabled"><Loader2 size={14} className="spin" /> {t('mods.installing')}</span>
                : <button className="btn primary sm" onClick={() => install(target, pname)}>{t('clips.rec.install', { mod: target })}</button>)}
            </div>
          );
        })}
      </div>
      <div className="rec-keys">
        <span><kbd>F3</kbd> {t('clips.keys.save')}</span>
        <span><kbd>Shift+F3</kbd> {t('clips.keys.window')}</span>
        <span><kbd>F8</kbd> {t('clips.keys.menu')}</span>
      </div>
      <span className="dim small">{t('clips.rec.settings')}</span>
    </section>
  );
}

// Videos from Documents\TrackMania\Clips (the clip-recording mod writes there). The thumbnail
// is the video's own first frame (preload=metadata, seeked a little in).
export function Clips() {
  const hub = useHubState();
  const t = useT();
  const [data, setData] = useState<{ dir: string | null; clips: Clip[] } | null>(null);
  const [playing, setPlaying] = useState<Clip | null>(null);
  const load = () => { backend.clips?.().then(setData).catch((e) => hub.toast({ message: String(e), ok: false })); };
  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps

  const dir = data?.dir ?? CLIPS_DIR;
  return (
    <div className="page wide">
      <div className="page-head">
        <div>
          <h1>{t('nav.clips')}</h1>
          <span className="dim">{data ? tp('clips.count', data.clips.length, { dir }) : isNative ? t('clips.loading') : t('clips.previewHint', { dir: CLIPS_DIR })}</span>
        </div>
        <div className="grow" />
        {isNative && <button className="btn ghost" onClick={load}><RefreshCw size={16} /> {t('common.reload')}</button>}
        {isNative && data?.dir && data.clips.length > 0 && <button className="btn ghost" onClick={() => backend.reveal?.(data.dir!)}><FolderOpen size={16} /> {t('common.folder')}</button>}
      </div>

      <RecordingCard />

      {data && data.clips.length === 0 && (
        <div className="empty-state">
          <Clapperboard size={42} strokeWidth={1.4} />
          <b>{t('clips.empty')}</b>
          <span className="dim">{tn('clips.emptyText', { dir: <span className="mono">{dir}</span> })}</span>
        </div>
      )}

      {data && data.clips.length > 0 && (
        <div className="clip-grid">
          {data.clips.map((c) => (
            <div className="clip" key={c.path}>
              <button className="clip-thumb" onClick={() => setPlaying(c)} title={t('common.play')}>
                <video src={c.src + '#t=0.5'} preload="metadata" muted playsInline />
                <span className="clip-play"><Play size={22} fill="currentColor" /></span>
              </button>
              <div className="clip-body">
                <div className="grow min0">
                  <b className="ellip" title={c.name}>{c.name.replace(/\.(mp4|webm|mkv)$/i, '')}</b>
                  <div className="dim small">{timeAgo(c.modified)} · {fmtSize(c.size)}</div>
                </div>
                <button className="btn icon tiny" title={t('clips.showInFolder')} onClick={() => backend.reveal?.(c.path)}><FolderOpen size={14} /></button>
              </div>
            </div>
          ))}
        </div>
      )}

      {playing && toBody(
        <div className="modal-bg" onMouseDown={(e) => { if (e.target === e.currentTarget) setPlaying(null); }}>
          <div className="player">
            <div className="player-head">
              <b className="ellip grow" title={playing.name}>{playing.name}</b>
              <button className="btn ghost sm" onClick={() => backend.reveal?.(playing.path)}><FolderOpen size={14} /> {t('clips.showInFolder')}</button>
              <button className="bbtn" aria-label={t('common.close')} onClick={() => setPlaying(null)}><X size={16} /></button>
            </div>
            <video src={playing.src} controls autoPlay />
          </div>
        </div>,
      )}
    </div>
  );
}
