import { useState } from 'react';
import { ArrowLeft, ArrowRight, Check, ChevronDown, Download, ExternalLink, FolderOpen, Info, Lock, Play, RotateCw, X } from 'lucide-react';
import { useHubState } from '../state';
import { GameArt, GameChip } from '../ui/common';
import { MAP_OPEN, TMX_SITE } from '../data/tmx';
import { backend, isNative } from '../data/backend';
import { Embedded } from './Embedded';
import { useT } from '../i18n';

// TMX inside the launcher. A browser page cannot frame TMX (X-Frame-Options: SAMEORIGIN),
// so the prototype shows a static capture; the native app uses a WebView2 that catches
// .Gbx downloads, saves them into the game's folder and offers Play.
export function Maps({ initial }: { initial?: string }) {
  return isNative ? <Embedded mode="maps" initial={initial} /> : <PreviewMaps initial={initial} key={initial} />;
}

function PreviewMaps({ initial }: { initial?: string }) {
  const hub = useHubState();
  const t = useT();
  const titles = hub.games.filter((g) => TMX_SITE[g.id]);
  const start = initial && TMX_SITE[initial] ? initial : TMX_SITE[hub.selectedGame] ? hub.selectedGame : 'tmnf';
  const [gameId, setGameId] = useState(start);
  const [menu, setMenu] = useState(false);
  const [caught, setCaught] = useState(true);
  const g = hub.game(gameId);
  const host = TMX_SITE[gameId];
  const open = MAP_OPEN[gameId];
  const ext = g.family === 'maniaplanet' || g.family === 'tm2020' ? '.Map.Gbx' : '.Challenge.Gbx';
  const file = `${open.folder}\\A07-Race${ext}`;
  const prof = hub.profileFor(gameId);
  const exe = g.install?.exe ?? '<game exe>';
  const cmd = open.command.replace('%EXE%', exe).replace('%FILE%', '%USERPROFILE%\\' + file).replace('%TITLE%', g.titleId ?? '');
  const viaLoader = g.family === 'forever' && prof?.real;

  const play = async () => {
    if (!g.installed) { hub.toast({ message: t('play.notInstalled', { game: g.name }) }); return; }
    if (!open.direct) {
      hub.toast({ message: t('maps.previewSaved', { game: g.short }), command: hub.commandFor(g, prof) });
      return;
    }
    const pre = viaLoader ? hub.commandFor(g, prof) + '\n' : '';
    hub.toast(await backend.launch({ gameId }, pre + cmd));
  };

  return (
    <div className="browser">
      <div className="bbar">
        <button className="bbtn" title={t('web.back')}><ArrowLeft size={17} /></button>
        <button className="bbtn" title={t('web.forward')} disabled><ArrowRight size={17} /></button>
        <button className="bbtn" title={t('web.reload')}><RotateCw size={16} /></button>
        <div className="bgame">
          <button className="bgame-btn" onClick={() => setMenu(!menu)} title={t('web.exchangeFor')}>
            <GameArt game={g} variant="thumb" className="bgame-art" />
            <span>{g.short}</span>
            <ChevronDown size={15} />
          </button>
          {menu && (
            <div className="psel-menu down">
              {titles.map((x) => (
                <button key={x.id} className={'psel-item' + (x.id === gameId ? ' on' : '')} onClick={() => { setGameId(x.id); setMenu(false); setCaught(true); }}>
                  <span className="psel-check">{x.id === gameId && <Check size={14} />}</span>
                  <span className="grow">{x.name}</span>
                  <span className="dim small">{TMX_SITE[x.id]}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="baddr">
          <Lock size={13} />
          <span>https://<b>{host}</b>/</span>
          <span className="grow" />
          <span className="cap-tag" title={t('maps.captureTip')}>{t('maps.capture')}</span>
        </div>
        <a className="bbtn" href={`https://${host}/`} target="_blank" rel="noreferrer" title={t('web.openBrowser')}><ExternalLink size={16} /></a>
      </div>

      <div className="bframe">
        <img src={`tmx-capture/${host}.jpg`} alt={t('maps.homeAlt', { host })} />
        {caught && (
          <div className="caught">
            <div className="caught-head">
              <span className="caught-ico"><Download size={16} /></span>
              <div className="grow">
                <b>A07-Race{ext}</b>
                <div className="dim small">{t('web.savedTo', { folder: open.folder })}</div>
              </div>
              <span className="pill tiny muted" title={t('maps.exampleTip')}>{t('maps.example')}</span>
              <button className="bbtn sm" aria-label={t('common.close')} onClick={() => setCaught(false)}><X size={14} /></button>
            </div>
            <div className="caught-meta">
              <GameChip id={gameId} />
              {open.direct
                ? <span className={'small ' + (open.status === 'verified' ? 'good' : 'acc-text')}>{open.status === 'verified' ? t('maps.opensDirect') : t('maps.shouldOpen')}</span>
                : <span className="small warn">{t('maps.startsGame')}</span>}
            </div>
            <code className="caught-cmd">{viaLoader ? t('maps.viaLoader', { profile: prof?.name }) + '\n' : ''}{open.direct ? cmd : hub.commandFor(g, prof) || '"<game exe>"'}</code>
            <p className="dim small">{t(open.noteKey)}{viaLoader ? ' ' + t('maps.loaderNote') : ''}</p>
            <div className="caught-actions">
              <button className="btn play sm" disabled={!g.installed} onClick={play} title={g.installed ? t('maps.playTip') : t('play.gameMissing')}><Play size={14} fill="currentColor" /> {t('common.play')}</button>
              <button className="btn ghost sm" onClick={() => hub.toast({ message: t('common.previewFolder'), command: '%USERPROFILE%\\' + open.folder })}><FolderOpen size={14} /> {t('common.folder')}</button>
            </div>
          </div>
        )}
        <div className="bnote"><Info size={13} /> {t('maps.note', { host })}</div>
      </div>
    </div>
  );
}
