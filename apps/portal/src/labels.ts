import type { GameId, HubInstallType, ReportReason, VersionStatus } from '@tm-hub/shared';

export const GAME_LABELS: Record<GameId, string> = {
  tmnf: 'TrackMania Nations Forever',
  tmuf: 'TrackMania United Forever',
  eswc: 'TrackMania Nations ESWC',
  'tm2-canyon': 'TrackMania 2 Canyon',
  'tm2-stadium': 'TrackMania 2 Stadium',
  'tm2-valley': 'TrackMania 2 Valley',
  'tm2-lagoon': 'TrackMania 2 Lagoon',
  'sm-storm': 'ShootMania Storm',
  tm2020: 'Trackmania (2020)',
  turbo: 'Trackmania Turbo',
  tmo: 'TrackMania Original',
  tms: 'TrackMania Sunrise',
};
export const gameName = (g: string) => GAME_LABELS[g as GameId] ?? g;

export const INSTALL_LABELS: Record<HubInstallType, string> = {
  'tmloader-product': 'TMLoader product (zip holds Product/version/)',
  'files:game': 'Files into the game folder',
  'files:gamedata': 'Files into GameData',
  'files:documents': 'Files into Documents/TrackMania',
  'files:tmi-plugins': 'TMInterface plugin (Plugins folder)',
  'files:tmi-scripts': 'TMInterface script (Scripts folder)',
};

export const REASON_LABELS: Record<ReportReason, string> = {
  malware: 'Malware or harmful code',
  copyright: 'Copyright infringement',
  'stolen-mod': 'Stolen or re-uploaded mod',
  illegal: 'Other illegal content',
  'cheat-online': 'Cheat for online play',
  'personal-data': 'Personal data',
  spam: 'Spam or misleading',
  other: 'Other',
};

export const STATUS_TONE: Record<VersionStatus, string> = {
  checking: 'info', held: 'warn', review: 'warn', published: 'ok', rejected: 'bad', cancelled: '', revoked: 'bad',
};

export const GROUNDS = [
  'Nutzungsbedingungen § 4 (Schadsoftware)',
  'Nutzungsbedingungen § 3 Rechte Dritter (Urheberrecht)',
];

export const fmtDate = (s: string | null | undefined) => (s ? new Date(s).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '-');
export const fmtDay = (s: string | null | undefined) => (s ? new Date(s).toLocaleDateString(undefined, { dateStyle: 'medium' }) : '-');
export const fmtSize = (n: number) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
export const initials = (s: string) => s.split(/[\s-]+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('');
