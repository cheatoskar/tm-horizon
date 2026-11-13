import { FolderPlus, HardDrive, Loader2, Play, RefreshCw, ShieldAlert } from 'lucide-react';
import { sourceText } from '../ui/GameMods';
import { go, useHubState } from '../state';
import { GameArt, PlayButton } from '../ui/common';
import { gameSeconds, usePlaytime, useFormatTime } from '../ui/Playtime';
import { timeAgo } from '../data/model';
import { backend, isNative } from '../data/backend';
import type { GameView } from '../data/types';
import { useT } from '../i18n';

function Card({ g, secs, fmt }: { g: GameView; secs: number; fmt: (s: number) => string }) {
  const hub = useHubState();
  const t = useT();
  const prof = hub.profileFor(g.id);
  const sub = g.installed
    ? [g.install ? sourceText(g.install.source, t).label : null, g.modSystem !== 'None' ? prof?.name ?? g.modSystem : null].filter(Boolean).join(' · ')
    : g.note ? t(g.note) : g.titleId ? t('library.packMissing') : g.store ? t('library.onStore', { store: g.store.label }) : t('play.notSold');
  return (
    <div className={'gcard' + (g.installed ? '' : ' missing')} onClick={() => go('game', g.id)} role="button" tabIndex={0} title={g.name}>
      <GameArt game={g} variant="cover">
        <span className="gcard-fam">{t('family.' + g.family)}</span>
        {g.installed && (
          <button className="gcard-play" aria-label={t('library.playAria', { game: g.name })} disabled={!!hub.launching[g.id] && hub.launching[g.id] !== 'running'} onClick={(e) => { e.stopPropagation(); hub.play(g.id); }}>
            {hub.launching[g.id] && hub.launching[g.id] !== 'running' ? <Loader2 size={26} className="spin" /> : <Play size={26} fill="currentColor" />}
          </button>
        )}
      </GameArt>
      <div className="gcard-body">
        <b title={g.name}>{g.name}</b>
        <span className="dim small" title={typeof sub === 'string' ? sub : undefined}>{sub}{secs > 0 && ` · ${fmt(secs)}`}</span>
        <PlayButton game={g} size="sm" />
      </div>
    </div>
  );
}

export function Library() {
  const hub = useHubState();
  const t = useT();
  const inst = hub.games.filter((g) => g.installed);
  const missing = hub.games.filter((g) => !g.installed);
  const eswc = hub.game('tmn-eswc');
  const played = usePlaytime();
  const fmt = useFormatTime();
  const ds = hub.driveScan;
  return (
    <div className="page wide">
      <div className="page-head">
        <div>
          <h1>{t('nav.library')}</h1>
          <span className="dim">{t('library.found', { n: inst.length, total: hub.games.length, ago: timeAgo(hub.snapshot.scannedAt) })}</span>
        </div>
        <div className="grow" />
        {isNative && backend.addFolder && (
          <button className="btn ghost" title={t('library.addGameTip')} onClick={async () => {
            const r = await backend.addFolder!();
            if (r.message !== 'Cancelled') hub.toast({ ok: r.added, message: r.added ? t('library.addedGame', { games: (r.games ?? []).join(', ') }) : (r.message ?? t('library.noGameThere')) });
          }}><FolderPlus size={16} /> {t('library.addGame')}</button>
        )}
        {isNative && (ds?.running
          ? <span className="lib-scan">
              <Loader2 size={14} className="spin" />
              <span className="small" title={ds.dir}>{t('library.scanningFound', { n: ds.dirs ?? 0, found: ds.found ?? 0 })}</span>
              <button className="btn ghost sm" onClick={() => backend.cancelDriveScan?.()}>{t('common.cancel')}</button>
            </span>
          : <button className="btn ghost" title={t('library.scanDrivesTip')} onClick={() => backend.scanDrives!().then(() => hub.setDriveScan({ running: true }))}>
              <HardDrive size={16} /> {t('library.scanDrives')}
            </button>)}
        <button className="btn ghost" title={t('library.scanTip')} onClick={async () => {
          if (!isNative) { hub.toast({ message: t('library.previewScan') }); return; }
          await backend.rescan();
          hub.toast({ message: t('library.scanned') });
        }}>
          <RefreshCw size={16} /> {t('library.scan')}
        </button>
      </div>
      <div className="lib-grid">
        {inst.map((g) => <Card key={g.id} g={g} secs={gameSeconds(played, g.id)} fmt={fmt} />)}
      </div>
      <h3 className="lib-sub">{t('common.notInstalled')}</h3>
      <div className="lib-grid">
        {missing.map((g) => <Card key={g.id} g={g} secs={0} fmt={fmt} />)}
      </div>
      {eswc.unsupported && (
        <div className="notice">
          <ShieldAlert size={18} />
          <div>
            <b>TrackMania Nations ESWC (original)</b>
            <span className="dim"> · {eswc.unsupported.path}</span>
            <div className="dim small">{t('library.eswcUnsupported')}</div>
          </div>
        </div>
      )}
    </div>
  );
}
