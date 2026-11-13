// Head of the "Horizon modules" view on the Mods page: what Horizon Client is, with its logo and
// pictures of the in-game menu (bundled in public/horizon-client, our own renders of the menu).
// Installing happens per game on the game pages, so the head only points there.
import { useState } from 'react';
import { go, useHubState } from '../state';
import { useT } from '../i18n';
import { Lightbox } from '../pages/Gallery';
import { moduleIconUrl, useModuleIconSet } from './moduleIcons';

const SHOTS = ['modules', 'performance', 'general', 'bar'].map((n) => `/horizon-client/${n}.jpg`);
const GAMES = ['tmn-eswc', 'tm-sunrise', 'tmnf', 'tmuf'];

export function HorizonClientIntro() {
  const t = useT();
  const hub = useHubState();
  const [open, setOpen] = useState<number | null>(null);
  const logo = moduleIconUrl('horizon-client', useModuleIconSet()) ?? '/app-icon.png';
  const installed = GAMES.map((id) => hub.games.find((g) => g.id === id)).filter((g) => g?.installed);
  return (
    <section className="hc-intro">
      <img className="hc-intro-logo" src={logo} alt="" width={72} height={72} />
      <div className="hc-intro-text">
        <h2>Horizon Client</h2>
        <p className="dim">{t('hc.lead')}</p>
        <div className="hc-intro-games">
          <span className="dim small">{t('hc.installOn')}</span>
          {installed.length === 0 && <span className="dim small">{t('hc.noGame')}</span>}
          {installed.map((g) => <button key={g!.id} className="btn ghost sm" onClick={() => go('game', g!.id)}>{g!.short}</button>)}
        </div>
      </div>
      <div className="hc-intro-shots">
        {SHOTS.map((s, i) => (
          <button key={s} className="hc-shot" onClick={() => setOpen(i)} aria-label={t('gallery.open')}><img src={s} alt="" loading="lazy" decoding="async" /></button>
        ))}
      </div>
      {open != null && <Lightbox list={SHOTS} index={open} setIndex={setOpen} />}
    </section>
  );
}
