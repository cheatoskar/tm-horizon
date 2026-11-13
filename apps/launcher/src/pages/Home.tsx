import { useLayoutEffect, useRef, useState } from 'react';
import { sourceText } from '../ui/GameMods';
import { ArrowRight, Info, Link2 } from 'lucide-react';
import { backend } from '../data/backend';
import { go, useHubState } from '../state';
import { GameCommunity, GameLive, GameStartPanel, hubGame } from './HomeGame';
import { GameArt, GameLogo, PlayButton, ProfileSelect, SectionHead } from '../ui/common';
import { NewsThumb } from '../ui/NewsThumb';
import { useNews } from '../data/news';
import { timeAgo } from '../data/model';
import { tp, useT } from '../i18n';

export function Home() {
  const hub = useHubState();
  const t = useT();
  const [allNews, setAllNews] = useState(false);
  const allItems = useNews(24).items;
  const hg = hubGame(hub.selectedGame);
  // TM².MX news (tagged tm2-stadium) covers every TM² environment: a selected Canyon, Valley or Lagoon gets it too.
  const tm2 = (x: string) => x === 'tm2' || x.startsWith('tm2-');
  const fits = (x: string) => x === hg || x === hub.selectedGame || (tm2(hub.selectedGame) && tm2(x));
  // As many as fit beside the left column (useFillCount hides the ones that would be cut).
  const news = (allNews ? allItems : allItems.filter((n) => n.games.some(fits))).slice(0, 24);
  const newsRef = useFillCount([news.length, allNews, hub.selectedGame]);
  const startRef = useRef<HTMLElement>(null);
  const g = hub.game(hub.selectedGame);
  const prof = hub.profileFor(g.id);
  const installed = hub.games.filter((x) => x.installed);
  return (
    <div className="home">
      <section className="hero">
        <GameArt game={g} variant="hero" className="hero-art" />
        <div className="hero-shade" />
        <div className="hero-content">
          <div className="hero-kicker">{t('family.' + g.family)} · {g.modSystem === 'None' ? t('common.noMods') : g.modSystem}</div>
          <GameLogo game={g} />
          <div className="hero-sub">
            {g.install ? <>{t('home.from', { source: sourceText(g.install.source, t).label })}{g.titleId && <> · {g.titleId}</>}</> : t('common.notInstalled')}
            {prof && <> · {prof.mods.length ? tp('home.profileMods', prof.mods.length, { name: prof.name }) : t('home.profileNoMods', { name: prof.name })}</>}
          </div>
          <div className="hero-actions">
            {/* Play starts at once with the selected profile (same path as every Play); the info button opens the
                game page. Not set up: Get / setup as before. */}
            <span className="play-split">
              <PlayButton game={g} />
            </span>
            <ProfileSelect game={g} />
            <button className="btn icon glass" title={t('home.gameDetails')} onClick={() => go('game', g.id)}><Info size={18} /></button>
          </div>
        </div>
        <div className="switcher">
          {installed.map((x) => (
            <button key={x.id} className={'sw' + (x.id === g.id ? ' on' : '')} onClick={() => hub.setSelectedGame(x.id)} title={x.name}>
              <GameArt game={x} variant="tile" />
              <span>{x.short}</span>
            </button>
          ))}
        </div>
      </section>

      <ProtocolBanner />
      <div className="home-grid">
        <div className="home-col">
          <GameStartPanel g={g} ref={startRef} />
          <GameLive g={g} />
          <GameCommunity g={g} />
        </div>
        <section className="panel home-news">
          <SectionHead title={t('home.news')} right={
            <div className="seg sm" role="radiogroup">
              <button role="radio" aria-checked={!allNews} className={!allNews ? 'on' : ''} onClick={() => setAllNews(false)}>{g.short ?? g.name}</button>
              <button role="radio" aria-checked={allNews} className={allNews ? 'on' : ''} onClick={() => setAllNews(true)}>{t('homeGame.allGames')}</button>
            </div>} />
          <div className="news-fill"><div className="news" ref={newsRef}>
            {news.map((n) => {
              const g = n.games.map((id) => hub.games.find((x) => x.id === id || (id === 'eswc' && x.id === 'tmn-eswc'))).find(Boolean);
              return (
                <button className="news-card" key={n.id} onClick={() => backend.openExternal(n.url)} title={n.url}>
                  <NewsThumb n={n} game={g} />
                  <div className="news-body">
                    <span className="news-tag">{n.kind === 'release' ? t('news.release') : t('news.exchange')} · {timeAgo(n.date)}</span>
                    <b className="ellip">{n.title}</b>
                    <span className="dim small clamp2">{n.text}</span>
                  </div>
                </button>
              );
            })}
            {news.length === 0 && <div className="dim small">{t('news.none')}</div>}
          </div></div>
          <button className="link-more" onClick={() => go('news')}>{t('news.all')} <ArrowRight size={14} /></button>
        </section>
      </div>
    </div>
  );
}

/** Hides the children of a list that do not fit its height completely (the list is sized by its container,
 * not by its content); re-checks when the size or `deps` change. */
function useFillCount(deps: unknown[]) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const box = ref.current;
    if (!box) return;
    const fit = () => {
      const h = box.clientHeight;
      for (const c of Array.from(box.children) as HTMLElement[]) {
        c.style.visibility = '';
        c.style.visibility = c.offsetTop + c.offsetHeight <= h + 1 ? '' : 'hidden';
      }
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(box);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return ref;
}

// First run: ask once whether tmhub:// links from the website may open TM Horizon (HKCU only). Not in the
// Launcher Preview: the website is private, so its install buttons do not exist yet (Settings keeps the switch).
function ProtocolBanner() {
  const hub = useHubState();
  const t = useT();
  const [show, setShow] = useState(() => !__RELEASE_PREVIEW__ && backend.info?.().settings.protocolAsked === false);
  if (!show) return null;
  const answer = async (yes: boolean) => {
    setShow(false);
    if (yes) hub.toast(await backend.protocol!.register());
    else await backend.saveSettings!({ protocolAsked: true });
  };
  return (
    <div className="notice banner">
      <Link2 size={18} />
      <div className="grow">
        <b>{t('home.protoTitle')}</b>
        <div className="dim small">{t('home.protoText')}</div>
      </div>
      <button className="btn primary sm" onClick={() => answer(true)}>{t('common.yes')}</button>
      <button className="btn ghost sm" onClick={() => answer(false)}>{t('common.notNow')}</button>
    </div>
  );
}
