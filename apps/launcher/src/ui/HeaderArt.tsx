// TMX Headers Contest 2022 art (local/preview only, see ART_CREDITS.md): a banner strip for the
// exchange pages and a blurred environment background for the game pages. Both components only
// load their images when they are on screen.
import art from '../generated/header-art.json';
import { useHubState } from '../state';

type SiteArt = { day: string; night: string; artist: string };
type EnvArt = SiteArt & { small: string };
// Public build: the contest art is preview-only, so the tables stay empty and nothing references the files.
const SITES = (__PUBLIC_BUILD__ ? {} : art.sites) as Record<string, SiteArt>;
const ENVS = (__PUBLIC_BUILD__ ? {} : art.envs) as Record<string, EnvArt>;

/** Game -> environment of the Dule backgrounds (closest match):
 * TM2 Canyon = red rock desert -> Desert, Valley = green hills and dirt -> Rally,
 * Lagoon = tropical -> Island, Original (Desert, Rally, Snow) -> Desert, Sunrise (Island, Coast, Bay) -> Island.
 * United has all seven environments and rotates by day of the year. No match (ShootMania, Trackmania
 * 2020, Turbo) = no background. */
const ENV_LIST = ['stadium', 'bay', 'coast', 'desert', 'island', 'rally', 'snow'];
const GAME_ENV: Record<string, string> = {
  tmnf: 'stadium', 'tmn-eswc': 'stadium', 'tm2-stadium': 'stadium', 'tm2-canyon': 'desert', 'tm2-valley': 'rally',
  'tm2-lagoon': 'island', 'tm-original': 'desert', 'tm-sunrise': 'island',
};
export function envOf(game: string): string | null {
  if (__PUBLIC_BUILD__) return null;
  if (game === 'tmuf') {
    const day = Math.floor((Date.now() - new Date(new Date().getFullYear(), 0, 0).getTime()) / 86400000);
    return ENV_LIST[day % ENV_LIST.length];
  }
  return GAME_ENV[game] ?? null;
}

const useNight = () => useHubState().look.theme !== 'light';

/** Banner of an exchange site; night variant in the dark and midnight themes. */
export function SiteBanner({ host }: { host: string }) {
  const night = useNight();
  const a = SITES[host];
  if (!a) return null;
  return (
    <div className="site-banner" title={`Header by ${a.artist}, TMX Headers Contest 2022`}>
      <img src={night ? a.night : a.day} alt="" loading="lazy" decoding="async" />
    </div>
  );
}

/** Blurred environment background for the hero of a game page. */
export function EnvBackdrop({ game }: { game: string }) {
  const night = useNight();
  const env = envOf(game);
  const a = env ? ENVS[env] : null;
  if (!a) return null;
  return (
    <div className="env-backdrop" aria-hidden>
      <img src={night ? a.night : a.day} alt="" loading="lazy" decoding="async" style={{ backgroundImage: `url(${a.small})` }} />
    </div>
  );
}
