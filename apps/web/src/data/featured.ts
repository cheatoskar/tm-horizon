// The home page's featured carousel, in one place.
//
//   FEATURED_AUTO   how many mods the shared rule picks (recently updated + popular, one per author;
//                   packages/shared/src/featured.ts). 0 = none by rule.
//   FEATURED_EXTRA  hand-picked slides after those. Each one links to the project's OFFICIAL page (opens in a new
//                   tab) and shows our own neutral tile with the name, never the project's screenshots or logo.
//
// IMAGES COME LATER: the authors have not given permission for screenshots or logos yet. When they do, add an
// `image` (an https picture the hub or the repository hosts, or a file in public/img) to the entry and show it in
// Home.astro the way the automatic slides do. Until then: text, game tags and a link only.
import type { Lang } from '../i18n';

export const FEATURED_AUTO = 3;

export interface FeaturedExtra {
  id: string;
  name: string;
  author: string;
  /** Hub game ids shown as tags. */
  games: string[];
  /** Official page of the project. */
  url: string;
  summary: Record<Lang, string>;
}

export const FEATURED_EXTRA: FeaturedExtra[] = [
  {
    id: 'tm-competition-patch', name: 'Competition Patch', author: 'donadigo', games: ['tmnf', 'tmuf'], url: 'https://donadigo.com/tmcp',
    summary: {
      en: 'The patch for TrackMania Nations and United Forever that closes cheating holes, so competition results can be trusted.',
      de: 'Der Patch für TrackMania Nations und United Forever, der Schummel-Lücken schließt, damit Wettbewerbsergebnisse vertrauenswürdig sind.',
      fr: 'Le patch pour TrackMania Nations et United Forever qui ferme les failles de triche, pour des résultats de compétition fiables.',
      pl: 'Łatka do TrackMania Nations i United Forever, która zamyka luki dla oszustów, żeby wyniki zawodów były wiarygodne.',
    },
  },
  {
    id: 'tmunlimiter', name: 'TMUnlimiter', author: 'TMUnlimiter team', games: ['tmnf', 'tmuf'], url: 'https://unlimiter.net/',
    summary: {
      en: 'Lifts the block and map limits of TrackMania Forever. Version 2.0 adds map scripts and installs through TMLoader.',
      de: 'Hebt die Block- und Kartengrenzen von TrackMania Forever auf. Version 2.0 bringt Karten-Skripte und wird über TMLoader installiert.',
      fr: 'Supprime les limites de blocs et de cartes de TrackMania Forever. La version 2.0 ajoute des scripts de carte et s’installe via TMLoader.',
      pl: 'Znosi limity bloków i map w TrackMania Forever. Wersja 2.0 dodaje skrypty map i instaluje się przez TMLoader.',
    },
  },
];
