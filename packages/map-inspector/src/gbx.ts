/**
 * Reading the JSON that `io.gbx.tools/gbx-to-json` produces from a .Gbx map.
 *
 * Pure functions over a parsed object - no database, no fetch - so the whole
 * inspector runs in the browser and a map file never leaves the machine it is
 * on. That is the point: a .Gbx is somebody's unpublished work as often as not,
 * and the only thing this site ever sees is the map's UID, and only if they ask
 * it to look the map up.
 *
 * Everything here is defensive. The shape varies between GBX versions and
 * between what the converter chooses to emit, so every field is optional and
 * every lookup tolerates the key being absent, a different type, or nested one
 * level deeper than last time.
 */

import { parseTime } from "./medals.ts";

export type Json = Record<string, unknown>;

const asObj = (v: unknown): Json | null =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null;
const asStr = (v: unknown): string | null => (typeof v === "string" ? v : null);
const asNum = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
/** Seconds as the file stores them, in the milliseconds the rest of this uses. */
const sec = (v: number | null): number | null => (v === null ? null : Math.round(v * 1000));

/** `Collection: { String: "Stadium" }` is the usual shape; a bare string happens too. */
function collectionName(v: unknown): string | null {
  const o = asObj(v);
  if (o) return asStr(o.String) ?? asStr(o.Id);
  return asStr(v);
}

/**
 * The converter wraps the map in `Node`, but not always, and a file dropped in
 * from somewhere else may already be unwrapped. Accept either rather than
 * making the reader care.
 */
export function unwrap(root: unknown): Json | null {
  const o = asObj(root);
  if (!o) return null;
  const node = asObj(o.Node);
  // `Node` is only the wrapper if the map-ish fields live inside it.
  if (node && (node.MapName !== undefined || node.MapInfo !== undefined || node.Blocks !== undefined)) return node;
  return o;
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

export type BlockKind = "start" | "checkpoint" | "finish" | "multilap";

export interface SpecialBlock {
  kind: BlockKind;
  name: string;
  x: number;
  y: number;
  z: number;
  /** "North" | "East" | "South" | "West", as the file spells it. */
  direction: string | null;
}

/**
 * Which of the four route blocks a block name is, if any.
 *
 * Two things carry this, and both were learned the hard way.
 *
 * **Order.** A multilap block is `...StartFinish`, so it has to be tested before
 * both `Start` and `Finish` or it files itself as one of them and the lap count
 * stops meaning anything.
 *
 * **The start must be a `StartLine`, not merely something containing "Start".**
 * A great many ordinary blocks end in `Start` without being one: surveyed
 * across real maps, `StadiumPlatformLoopStart`, `StadiumRoadMainBiSlopeStart`,
 * `StadiumCircuitLoopStart`, `IslandCroisetteSlopeStart`,
 * `IslandPlatformBiSlope2Start` and `IslandPlatformLoopGT4CornerStart` are all
 * just pieces of road. Matching bare `Start` put 75 phantom start blocks on one
 * 2639-block map. The genuine ones are `StadiumRoadMainStartLine` and
 * `IslandHighWayStartLine` - always `StartLine`, which is also what Weregoose's
 * own pattern looks for (`tLi`, beside `rtFi` for the multilap).
 *
 * The finish deliberately does *not* get the same treatment: real finishes come
 * both as `StadiumRoadMainFinishLine` and as a bare `IslandHighWayFinish`, and
 * nothing in the survey ended in `Finish` without being one.
 *
 * Checkpoints are the loosest on purpose - `Checkpoint`, `CheckpointRingV`,
 * `CheckpointRight`, `CheckpointSlopeLeft` are all checkpoints, and counting
 * them that way reproduces the 225 a known map is supposed to have.
 */
export function classifyBlock(name: string): BlockKind | null {
  if (/startfinish/i.test(name)) return "multilap";
  if (/checkpoint/i.test(name)) return "checkpoint";
  if (/finish/i.test(name)) return "finish";
  if (/startline/i.test(name)) return "start";
  return null;
}

/**
 * One block, however it was read.
 *
 * The two front ends disagree on everything cosmetic - `Name` vs `blockName`,
 * `Coord` vs `position`, `"North"` vs `0` - so they both normalise to this and
 * everything downstream only ever sees one shape.
 */
export interface RawBlock {
  name: string;
  x: number;
  y: number;
  z: number;
  direction: string | null;
}

/** Reading a .Gbx gives the facing as an index; the converter spells it out. */
export const DIRECTIONS = ["North", "East", "South", "West"];

export function directionName(v: unknown): string | null {
  if (typeof v === "string") return v || null;
  if (typeof v === "number") return DIRECTIONS[v] ?? null;
  return null;
}

/** Blocks out of the JSON the converter produces. */
export function blocksFromJson(map: Json): RawBlock[] {
  const blocks = Array.isArray(map.Blocks) ? map.Blocks : [];
  const out: RawBlock[] = [];
  for (const raw of blocks) {
    const b = asObj(raw);
    if (!b) continue;
    const name = asStr(b.Name);
    const c = asObj(b.Coord);
    const x = asNum(c?.X);
    const y = asNum(c?.Y);
    const z = asNum(c?.Z);
    if (!name || x === null || y === null || z === null) continue;
    out.push({ name, x, y, z, direction: directionName(b.Direction) });
  }
  return out;
}

export interface SolidBlock {
  x: number;
  y: number;
  z: number;
  /** Route blocks keep their kind so the 3D view can colour them. */
  kind: BlockKind | null;
  /** The game's own name, so any of them can be picked out and plotted. */
  name: string;
}

/**
 * Every block, at its own height.
 *
 * The flat views only need the top of each column; the 3D view needs all of
 * them, because a road running under a bridge is exactly the checkpoint you
 * cannot otherwise see. Capped so a pathological file cannot ask the canvas to
 * draw a million cubes.
 */
export const MAX_SOLIDS = 20000;

export function solids(blocks: RawBlock[]): SolidBlock[] {
  const out: SolidBlock[] = [];
  for (const b of blocks) {
    if (out.length >= MAX_SOLIDS) break;
    out.push({ x: b.x, y: b.y, z: b.z, kind: classifyBlock(b.name), name: b.name });
  }
  return out;
}

/**
 * What is actually in this map, by name.
 *
 * Weregoose wanted a field to type block names into and have them plotted. A
 * map carries its own list, so rather than asking anybody to guess at spellings
 * this hands them the real ones with counts - `StadiumWater x 105` - and they
 * pick. Names are the game's, so they are stable across maps of an environment.
 */
export function blockNames(blocks: RawBlock[]): { name: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const b of blocks) counts.set(b.name, (counts.get(b.name) ?? 0) + 1);
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

export function specialBlocks(blocks: RawBlock[]): SpecialBlock[] {
  const out: SpecialBlock[] = [];
  for (const b of blocks) {
    const kind = classifyBlock(b.name);
    if (kind) out.push({ kind, ...b });
  }
  return out;
}

export interface Footprint {
  /** One entry per occupied column, keyed "x,z", holding the highest block in it. */
  cells: Map<string, { x: number; z: number; top: number; count: number }>;
  minY: number;
  maxY: number;
}

/**
 * The map seen from above: every block flattened onto the ground plane.
 *
 * This is what turns a list of coordinates into something a person recognises.
 * Four route markers on an empty grid say nothing; the same markers on the
 * actual silhouette of the track are instantly readable, and the file already
 * carries every block's position so it costs one pass.
 *
 * Columns keep only their highest block. A stack of pillars under a road is not
 * information at this scale - the height of the surface you would drive on is.
 */
export function footprint(blocks: RawBlock[]): Footprint {
  const cells = new Map<string, { x: number; z: number; top: number; count: number }>();
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const b of blocks) {
    const { x, y, z } = b;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    const key = `${x},${z}`;
    const existing = cells.get(key);
    if (existing) {
      existing.count++;
      if (y > existing.top) existing.top = y;
    } else {
      cells.set(key, { x, z, top: y, count: 1 });
    }
  }

  return {
    cells,
    minY: Number.isFinite(minY) ? minY : 0,
    maxY: Number.isFinite(maxY) ? maxY : 0,
  };
}



// ---------------------------------------------------------------------------
// A deep walk, for the things that are nested somewhere different every time
// ---------------------------------------------------------------------------

export interface MediaText {
  text: string;
  /** Milliseconds into the clip. Null when the block carries no keys. */
  start: number | null;
  end: number | null;
  /** The colour the author picked, as CSS. */
  color: string | null;
}

/** `Color: { X: 0.91, Y: 0.17, Z: 0.05 }` - floats, not bytes. */
function floatColour(v: unknown): string | null {
  const o = asObj(v);
  if (!o) return null;
  const ch = (n: unknown) => {
    const f = asNum(n);
    return f === null ? null : Math.max(0, Math.min(255, Math.round(f * 255)));
  };
  const r = ch(o.X);
  const g = ch(o.Y);
  const b = ch(o.Z);
  if (r === null || g === null || b === null) return null;
  return `rgb(${r},${g},${b})`;
}

/**
 * When a text block starts and stops.
 *
 * The times live on the effect's keyframes as strings (`"0:03.000"`), and a
 * block is on screen from its first key to its last - so the first and last are
 * the whole answer and everything between them is the animation.
 */
function keyTimes(block: Json): { start: number | null; end: number | null } {
  const effect = asObj(block.Effect);
  const keys = Array.isArray(effect?.Keys) ? effect.Keys : null;
  if (!keys || keys.length === 0) return { start: null, end: null };

  const times: number[] = [];
  for (const raw of keys) {
    const k = asObj(raw);
    if (!k) continue;
    // Two spellings, two units. The converter usually writes a formatted
    // string, which `parseTime` reads as milliseconds. When it writes a bare
    // number it is the underlying field, and that is **seconds** - a float in
    // GBX.NET's own type - so it has to be scaled or every caption in the map
    // is reported a thousand times too early and lasting no time at all.
    const t = typeof k.Time === "string" ? parseTime(k.Time) : sec(asNum(k.Time));
    if (t !== null) times.push(t);
  }
  if (times.length === 0) return { start: null, end: null };
  return { start: Math.min(...times), end: Math.max(...times) };
}

/**
 * Every line the map puts on screen, with when it appears and for how long.
 *
 * Text blocks sit under the intro clip, the in-game clip, the podium clip or a
 * group several levels down, and the nesting differs by GBX version - so this
 * walks the whole tree for `$type` rather than guessing a path. The file is
 * already in memory and a map has a few dozen of these.
 *
 * Only the converted JSON carries them: `gbx.js` force-skips the MediaTracker
 * chunk (0x03043021) when reading a challenge, so a .Gbx opened directly has no
 * clips to find. That is the one thing the two readers genuinely differ on.
 */
export function mediaTrackerTexts(map: Json): MediaText[] {
  const found: MediaText[] = [];
  const seen = new Set<unknown>();

  const walk = (v: unknown, depth: number) => {
    if (depth > 40 || v === null || typeof v !== "object") return;
    if (seen.has(v)) return;
    seen.add(v);

    if (Array.isArray(v)) {
      for (const item of v) walk(item, depth + 1);
      return;
    }
    const o = v as Json;
    const type = asStr(o.$type);
    if (type && /CGameCtnMediaBlockText/.test(type)) {
      const text = asStr(o.Text);
      if (text && text.trim()) {
        const { start, end } = keyTimes(o);
        found.push({ text, start, end, color: floatColour(o.Color) });
      }
    }
    for (const key of Object.keys(o)) walk(o[key], depth + 1);
  };

  walk(map, 0);

  // In the order they appear on screen, which is how anybody reads them.
  return found.sort((a, b) => (a.start ?? Infinity) - (b.start ?? Infinity));
}

/**
 * A MediaTracker trigger: the cells that fire a clip when you drive into them.
 *
 * `coords` are block coordinates in the same grid the blocks use, so they can
 * be drawn straight onto the map - which is the whole point of reading them.
 */
export interface MediaTrigger {
  /** The clip it fires, named as well as the file allows. */
  clip: string | null;
  coords: { x: number; y: number; z: number }[];
}

/** An `int3` as this converter writes it: `{ X, Y, Z }`, same as a block Coord. */
function int3(raw: unknown): { x: number; y: number; z: number } | null {
  const o = asObj(raw);
  const x = asNum(o?.X);
  const y = asNum(o?.Y);
  const z = asNum(o?.Z);
  return x === null || y === null || z === null ? null : { x, y, z };
}

/** The first line of text inside a clip, as a name of last resort. */
function firstTextIn(clip: unknown): string | null {
  const texts = mediaTrackerTexts((asObj(clip) ?? {}) as Json);
  return texts[0]?.text ?? null;
}

/**
 * Which blocks set the MediaTracker off, and what they set off.
 *
 * Two passes, because one was not enough. The documented shape is a clip
 * group whose `Clips` pairs each clip with a `Trigger` holding `Coords`, and
 * matching that gets the clip's *name* as well as its cells. But the exact
 * nesting differs between converter versions - a record struct can serialise
 * positionally, a field can be renamed - and a trigger that is found without
 * a name is still worth drawing. So:
 *
 *   1. the explicit pairing, which yields named triggers;
 *   2. anything else anywhere in the tree carrying a list of int3 under
 *      `Coords`, named from the nearest enclosing `Name` if there is one.
 *
 * Deduplicated on the cells, so a trigger found both ways is listed once and
 * the named version wins. Same caveat as the texts: converted JSON only,
 * because `gbx.js` force-skips the chunk the MediaTracker lives in.
 */
export function mediaTrackerTriggers(map: Json): MediaTrigger[] {
  const found = new Map<string, MediaTrigger>();

  const key = (coords: { x: number; y: number; z: number }[]) =>
    coords.map((c) => `${c.x}.${c.y}.${c.z}`).join("|");

  const record = (clip: string | null, raw: unknown) => {
    if (!Array.isArray(raw) || raw.length === 0) return;
    const coords = raw.map(int3).filter((c): c is { x: number; y: number; z: number } => c !== null);
    // All-or-nothing: a "Coords" that is a list of something else is not a
    // trigger, and half-parsing one would put phantom cells on the map.
    if (coords.length === 0 || coords.length !== raw.length) return;
    const k = key(coords);
    const existing = found.get(k);
    if (existing && (existing.clip || !clip)) return;
    found.set(k, { clip, coords });
  };

  // Pass 1: the pairing, which is the only place a clip name can come from.
  const paired = new Set<unknown>();
  const walkPairs = (v: unknown, depth: number) => {
    if (depth > 40 || v === null || typeof v !== "object") return;
    if (Array.isArray(v)) {
      for (const item of v) walkPairs(item, depth + 1);
      return;
    }
    const o = v as Json;
    if (Array.isArray(o.Clips)) {
      for (const raw of o.Clips) {
        const entry = asObj(raw);
        if (!entry) continue;
        const trigger = asObj(entry.Trigger);
        if (!trigger || !Array.isArray(trigger.Coords)) continue;
        paired.add(trigger);
        const named = asStr(asObj(entry.Clip)?.Name);
        record(named?.trim() || firstTextIn(entry.Clip), trigger.Coords);
      }
    }
    for (const k of Object.keys(o)) walkPairs(o[k], depth + 1);
  };

  // Pass 2: anything shaped like a trigger that pass 1 did not reach.
  const walkLoose = (v: unknown, depth: number, name: string | null) => {
    if (depth > 40 || v === null || typeof v !== "object") return;
    if (Array.isArray(v)) {
      for (const item of v) walkLoose(item, depth + 1, name);
      return;
    }
    const o = v as Json;
    const here = asStr(o.Name)?.trim() || name;
    if (Array.isArray(o.Coords) && !paired.has(o)) record(here, o.Coords);
    for (const k of Object.keys(o)) walkLoose(o[k], depth + 1, here);
  };

  walkPairs(map, 0);
  walkLoose(map, 0, null);

  return [...found.values()];
}

// ---------------------------------------------------------------------------
// Identity, medals, mode
// ---------------------------------------------------------------------------

export type ScoreKind = "time" | "score" | "respawns";

export interface MapSummary {
  name: string | null;
  author: string | null;
  uid: string | null;
  environment: string | null;
  mood: string | null;
  size: { x: number; y: number; z: number } | null;
  /** Base64 JPEG straight out of the file, if the converter kept it. */
  thumbnail: string | null;
  mode: string | null;
  scoreKind: ScoreKind;
  isLapRace: boolean;
  laps: number | null;
  /**
   * The checkpoint count the **header** claims, which is not always the
   * number of checkpoint blocks in the body.
   *
   * They are written at different moments, so they part company when a map is
   * edited after it was validated - the sheet excludes maps with the note
   * "There are more cps than 0x017 expects; revalidating fixes it". Kept
   * separate from the counted blocks on purpose: the disagreement is the
   * signal, so collapsing them would destroy it.
   */
  checkpointsDeclared: number | null;
  bronze: number | null;
  silver: number | null;
  gold: number | null;
  authorTime: number | null;
  authorScore: number | null;
  comments: string | null;
  blocks: number;
  /** Only set when the map forces a car its environment would not normally use. */
  vehicleMismatch: { vehicle: string; expected: string } | null;
}

/** The car each environment drives unless the map overrides it. */
const DEFAULT_VEHICLE: Record<string, string> = {
  Stadium: "StadiumCar",
  Desert: "DesertCar",
  Snow: "SnowCar",
  Rally: "RallyCar",
  Island: "IslandCar",
  Bay: "BayCar",
  Coast: "CoastCar",
};

/**
 * What the medal numbers mean depends on the mode, and getting it wrong is
 * worse than not showing them: in Stunts a bigger AuthorScore is better, in
 * Platform it is a respawn count where zero is perfect, and in Race and Puzzle
 * the medals are milliseconds.
 */
export function scoreKindFor(mode: string | null): ScoreKind {
  if (!mode) return "time";
  if (/stunt/i.test(mode)) return "score";
  if (/platform/i.test(mode)) return "respawns";
  return "time";
}

function findVehicle(map: Json): string | null {
  const direct = asStr(map.PlayerModel);
  if (direct) return direct;
  const o = asObj(map.PlayerModel);
  if (o) return asStr(o.Id) ?? asStr(o.Name);
  const vehicle = asObj(map.Vehicle);
  if (vehicle) return asStr(vehicle.Id) ?? asStr(vehicle.Name);
  return null;
}

export function summarise(map: Json, blockTotal: number): MapSummary {
  const info = asObj(map.MapInfo);
  const decoration = asObj(map.Decoration);
  const size = asObj(map.Size);
  const params = asObj(map.ChallengeParameters);

  const environment = collectionName(map.Collection) ?? collectionName(info?.Collection);
  const mode = asStr(map.Mode) ?? asStr(params?.MapType);

  // The medal times live on the map, but some files only carry them on
  // ChallengeParameters - take whichever is present.
  const pick = (a: unknown, b: unknown) => asNum(a) ?? asNum(b);

  const vehicle = findVehicle(map);
  const expected = environment ? DEFAULT_VEHICLE[environment] : undefined;
  const vehicleMismatch =
    vehicle && expected && !vehicle.toLowerCase().includes(expected.toLowerCase())
      ? { vehicle, expected }
      : null;

  const laps = asNum(map.NbLaps) ?? asNum(params?.NbLaps);

  return {
    name: asStr(map.MapName) ?? asStr(info?.Name),
    author: asStr(map.AuthorLogin) ?? asStr(info?.Author),
    uid: asStr(map.MapUid) ?? asStr(info?.Id),
    environment,
    mood: asStr(decoration?.Id),
    size:
      size && asNum(size.X) !== null
        ? { x: asNum(size.X)!, y: asNum(size.Y) ?? 0, z: asNum(size.Z) ?? 0 }
        : null,
    thumbnail: asStr(map.Thumbnail),
    mode,
    scoreKind: scoreKindFor(mode),
    isLapRace: map.IsLapRace === true,
    laps,
    checkpointsDeclared: pick(map.NbCheckpoints, params?.NbCheckpoints),
    bronze: pick(map.BronzeTime, params?.BronzeTime),
    silver: pick(map.SilverTime, params?.SilverTime),
    gold: pick(map.GoldTime, params?.GoldTime),
    authorTime: pick(map.AuthorTime, params?.AuthorTime),
    authorScore: pick(map.AuthorScore, params?.AuthorScore),
    comments: asStr(map.Comments),
    blocks: blockTotal,
    vehicleMismatch,
  };
}

/** Everything the inspector shows, from one parsed file. */
export interface Inspection {
  summary: MapSummary;
  route: SpecialBlock[];
  ground: Footprint;
  /** Every block at its real height, for the 3D view. */
  solid: SolidBlock[];
  /** Distinct block names with counts, for plotting whatever you like. */
  names: { name: string; count: number }[];
  texts: MediaText[];
  /** Cells that set a clip off. Converted JSON only, like `texts`. */
  triggers: MediaTrigger[];
  /**
   * Whether the block layout could be read at all.
 *
   * Reading a .Gbx gets the header in a few milliseconds and then has to
   * decompress the body for the blocks, which is the part that can fail. The
   * identity, the medals and the thumbnail survive that; the map drawing does
   * not, and the page has to say so rather than draw an empty grid.
   */
  hasLayout: boolean;
  /**
   * Where this reading came from.
   *
   * Only the MediaTracker needs it, and only to explain itself: a .Gbx read
   * here never has clips (see `inspectGbx`), so an empty `texts` means "not
   * available from this file" rather than "this map has no MediaTracker", and
   * those are different sentences to put in front of somebody.
   *
   * Optional because `remember()` keeps an Inspection in localStorage: a map
   * saved before this field existed comes back without it, and "unknown" has
   * to stay a state the page can render.
   */
  source?: "gbx" | "json";
}

function assemble(map: Json, blocks: RawBlock[], hasLayout: boolean): Inspection {
  return {
    summary: summarise(map, blocks.length),
    route: specialBlocks(blocks),
    ground: footprint(blocks),
    solid: solids(blocks),
    names: blockNames(blocks),
    texts: mediaTrackerTexts(map),
    triggers: mediaTrackerTriggers(map),
    hasLayout,
    source: "json",
  };
}

/** From the JSON that `io.gbx.tools` produces. */
export function inspect(root: unknown): Inspection | null {
  const map = unwrap(root);
  if (!map) return null;
  const blocks = blocksFromJson(map);
  const summary = summarise(map, blocks.length);
  // A file with none of these is not a map - probably a replay, or a challenge
  // the converter emitted differently. Saying so beats guessing.
  if (summary.name === null && summary.uid === null && !Array.isArray(map.Blocks)) return null;
  return assemble(map, blocks, Array.isArray(map.Blocks));
}

/**
 * From a .Gbx read directly by `gbx.js`.
 *
 * Its field names are the game's own (`blockName`, `position`, a numeric
 * `direction`) rather than the converter's, so this maps them across and then
 * hands off to exactly the same code. Two readers, one set of answers.
 */
export function inspectGbx(node: Record<string, unknown>, thumbnailBase64: string | null): Inspection | null {
  const info = asObj(node.mapInfo);
  const decoration = asObj(node.decoration);
  const size = asObj(node.size);
  const player = asObj(node.playerModel);

  const rawBlocks = Array.isArray(node.blocks) ? node.blocks : [];
  const blocks: RawBlock[] = [];
  for (const raw of rawBlocks) {
    const b = asObj(raw);
    if (!b) continue;
    const name = asStr(b.blockName);
    const p = asObj(b.position);
    const x = asNum(p?.x);
    const y = asNum(p?.y);
    const z = asNum(p?.z);
    if (!name || x === null || y === null || z === null) continue;
    blocks.push({ name, x, y, z, direction: directionName(b.direction) });
  }

  // Re-spelled into the converter's shape so `summarise` stays the only place
  // that decides what a summary is.
  const asConverterShape: Json = {
    MapName: asStr(node.mapName),
    AuthorLogin: asStr(node.authorLogin) ?? asStr(node.authorNickname) ?? asStr(info?.author),
    MapUid: asStr(info?.id),
    Collection: asStr(info?.collection),
    Decoration: decoration ? { Id: asStr(decoration.id) } : null,
    Size: size ? { X: asNum(size.x), Y: asNum(size.y), Z: asNum(size.z) } : null,
    Thumbnail: thumbnailBase64,
    Mode: asStr(node.mapType),
    IsLapRace: node.isLapRace === true,
    NbLaps: asNum(node.nbLaps),
    NbCheckpoints: asNum(node.nbCheckpoints),
    BronzeTime: asNum(node.bronzeTime),
    SilverTime: asNum(node.silverTime),
    GoldTime: asNum(node.goldTime),
    AuthorTime: asNum(node.authorTime),
    AuthorScore: asNum(node.authorScore),
    Comments: asStr(node.comments),
    PlayerModel: player ? { Id: asStr(player.id) } : null,
  };

  const summary = summarise(asConverterShape, blocks.length);
  if (summary.name === null && summary.uid === null) return null;

  return {
    summary,
    route: specialBlocks(blocks),
    ground: footprint(blocks),
    solid: solids(blocks),
    names: blockNames(blocks),
    // gbx.js force-skips the MediaTracker chunk, so a .Gbx read directly has no
    // clips to find and this is empty. The converted JSON has them.
    texts: mediaTrackerTexts(node as Json),
    triggers: [],
    hasLayout: blocks.length > 0,
    source: "gbx",
  };
}
