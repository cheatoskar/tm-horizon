// "Beitreten" for Nations ESWC, Sunrise and Original. These games take no join link or start option:
// their exes only know /bench, /config=, /data=, /game= (Sunrise), /list_benchs=, /netip=, /nodaemon,
// /nologs, /out=, /title= (read-only string search, 2026-11-11; TMNF/TMUF have /join, /url and tmtp://).
// So instead of a dead button: a short guide for the in-game network menu, the server name and
// address to copy, and a normal game start on the user's click. No URL scheme is registered.
import { useState } from 'react';
import { Copy, Play } from 'lucide-react';
import { useHubState } from '../state';
import { useT } from '../i18n';
import { copyText } from '../pages/CommunityServices';
import { Modal } from './Modal';

/** Launcher games that cannot be joined from outside the game. */
export const NO_JOIN_GAMES = ['tmn-eswc', 'tm-sunrise', 'tm-original'];
export const needsJoinGuide = (game: string | null | undefined) => !!game && NO_JOIN_GAMES.includes(game);

export function JoinGuideButton({ game, name, address, primary = false }: { game: string; name: string; address: string | null; primary?: boolean }) {
  const t = useT();
  const hub = useHubState();
  const [open, setOpen] = useState(false);
  const g = hub.game(game);
  const copied = (msg: string) => () => hub.toast({ message: msg });
  return (
    <>
      <button className={'btn sm ' + (primary ? 'primary' : 'ghost')} title={t('join.tip')} onClick={() => setOpen(true)}>{t('event.join')}</button>
      {open && (
        <Modal title={t('join.title', { server: name })} onClose={() => setOpen(false)}
          actions={<>
            <button className="btn ghost" onClick={() => copyText(name, copied(t('join.copiedName')))}><Copy size={14} /> {t('join.copyName')}</button>
            {address && <button className="btn ghost" onClick={() => copyText(address, copied(t('server.copied', { address })))}><Copy size={14} /> {t('join.copyAddress')}</button>}
            <button className="btn primary" disabled={!g?.installed} title={g?.installed ? undefined : t('play.gameMissing')}
              onClick={() => { setOpen(false); void hub.play(game); }}><Play size={14} fill="currentColor" /> {t('join.start')}</button>
          </>}>
          <div className="join-guide">
            <p className="small">{t('join.why', { game: g?.name ?? game })}</p>
            <ol className="small">
              <li>{t('join.step1')}</li>
              <li>{t('join.step2')}</li>
              <li>{t('join.step3', { name })}</li>
            </ol>
            {address && <p className="dim small">{t('join.address', { address })}</p>}
          </div>
        </Modal>
      )}
    </>
  );
}
