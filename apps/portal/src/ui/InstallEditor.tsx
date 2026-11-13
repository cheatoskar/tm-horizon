import { HUB_GAMES, HUB_INSTALL_TYPES, installOfType, typeOfInstall, type GameId, type HubInstall, type HubInstallType } from '@tm-hub/shared';
import { GAME_LABELS, INSTALL_LABELS } from '../labels.ts';
import { Checkbox } from './controls.tsx';

export const DEFAULT_INSTALL: HubInstall = { kind: 'files', base: 'game', strip: 0, include: [] };

export function InstallSelect({ value, onChange }: { value: HubInstall; onChange: (i: HubInstall) => void }) {
  const t = typeOfInstall(value);
  return (
    <div className="row">
      <select style={{ flex: '1 1 240px', width: 'auto' }} value={t} onChange={(e) => onChange(installOfType(e.target.value as HubInstallType, value.strip ?? 0, value.include ?? []))} aria-label="Install type">
        {HUB_INSTALL_TYPES.map((x) => <option key={x} value={x}>{INSTALL_LABELS[x]}</option>)}
      </select>
      <label className="row small muted" style={{ gap: 'var(--tm-s-2)', flexWrap: 'nowrap' }} title="Leading folders inside the zip to drop (0 to 3).">
        Strip
        <select style={{ width: 64 }} value={value.strip ?? 0} onChange={(e) => onChange({ ...value, strip: Number(e.target.value) })} aria-label="Strip folders">
          {[0, 1, 2, 3].map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
      </label>
    </div>
  );
}

export function GamePicker({ games, onChange }: { games: GameId[]; onChange: (g: GameId[]) => void }) {
  return (
    <div className="checks">
      {HUB_GAMES.map((g) => (
        <Checkbox key={g} label={GAME_LABELS[g]} checked={games.includes(g)} onChange={(on) => onChange(on ? [...games, g] : games.filter((x) => x !== g))} />
      ))}
    </div>
  );
}

/** Games plus one install type per selected game. */
export function InstallEditor({ games, installs, onChange }: {
  games: GameId[];
  installs: Partial<Record<GameId, HubInstall>>;
  onChange: (games: GameId[], installs: Partial<Record<GameId, HubInstall>>) => void;
}) {
  const setGames = (next: GameId[]) => {
    const inst: Partial<Record<GameId, HubInstall>> = {};
    for (const g of next) inst[g] = installs[g] ?? installs[games[0]!] ?? DEFAULT_INSTALL;
    onChange(next, inst);
  };
  return (
    <div className="stack">
      <GamePicker games={games} onChange={setGames} />
      {games.map((g) => (
        <div key={g}>
          <div className="lbl">{GAME_LABELS[g]}</div>
          <InstallSelect value={installs[g] ?? DEFAULT_INSTALL} onChange={(i) => onChange(games, { ...installs, [g]: i })} />
        </div>
      ))}
    </div>
  );
}
