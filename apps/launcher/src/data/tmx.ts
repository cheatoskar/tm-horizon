// TMX (TrackMania Exchange) per title, and how the launcher would open a downloaded map.
// Command lines: see README "Opening maps". "verified" = taken from the game's own
// registry file association on this PC; everything else is read from exe strings only.
export const TMX_SITE: Record<string, string> = {
  tmnf: 'tmnf.exchange',
  tmuf: 'tmuf.exchange',
  'tmn-eswc': 'nations.tm-exchange.com',
  'tm-original': 'original.tm-exchange.com',
  'tm-sunrise': 'sunrise.tm-exchange.com',
  'tm2-stadium': 'tm.mania.exchange',
  'tm2-canyon': 'tm.mania.exchange',
  'tm2-valley': 'tm.mania.exchange',
  'tm2-lagoon': 'tm.mania.exchange',
  'sm-storm': 'sm.mania.exchange',
  tm2020: 'trackmania.exchange',
};

export interface MapOpen {
  folder: string; // where the .Gbx is saved
  direct: boolean; // the game can open the map from the command line
  command: string; // %EXE%, %FILE%, %TITLE% are filled in by the launcher
  status: 'verified' | 'likely' | 'none';
  noteKey: string; // i18n key
}

const FOREVER: MapOpen = {
  folder: 'Documents\\TrackMania\\Tracks\\Challenges\\Downloaded',
  direct: true,
  command: '"%EXE%" /useexedir /singleinst /file="%FILE%"',
  status: 'verified',
  noteKey: 'tmxnote.forever',
};
const MP: MapOpen = {
  folder: 'Documents\\ManiaPlanet\\Maps\\Downloaded',
  direct: true,
  command: '"%EXE%" /useexedir /singleinst /title=%TITLE% /file="%FILE%"',
  status: 'likely',
  noteKey: 'tmxnote.mp',
};
const FALLBACK = (folder: string, noteKey: string): MapOpen => ({ folder, direct: false, command: '"%EXE%"', status: 'none', noteKey });

export const MAP_OPEN: Record<string, MapOpen> = {
  tmnf: FOREVER,
  tmuf: FOREVER,
  'tmn-eswc': FALLBACK('Documents\\TrackMania\\Tracks\\Challenges\\Downloaded', 'tmxnote.eswc'),
  'tm-original': FALLBACK('Tracks\\Challenges\\Downloaded', 'tmxnote.classic'),
  'tm-sunrise': FALLBACK('Tracks\\Challenges\\Downloaded', 'tmxnote.classic'),
  'tm2-stadium': MP, 'tm2-canyon': MP, 'tm2-valley': MP, 'tm2-lagoon': MP, 'sm-storm': MP,
  tm2020: {
    folder: 'Documents\\Trackmania2020\\Maps\\Downloaded',
    direct: true,
    command: '"%EXE%" /useexedir /singleinst /file="%FILE%"',
    status: 'likely',
    noteKey: 'tmxnote.tm2020',
  },
};
