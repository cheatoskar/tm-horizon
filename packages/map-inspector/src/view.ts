/**
 * Everything the map views share that is not drawing: colours, the drawing
 * grid, the build-order helpers and the block-name filter.
 *
 * From 100tmx.com (src/components/tools/MapViews.tsx and BlockPlotter.tsx),
 * pulled out of the React components so the website and the launcher draw the
 * same picture from the same numbers while each keeps its own page around it.
 */

import type { BlockKind, Inspection, SpecialBlock } from "./gbx.ts";

/** Labels are English defaults; a host translates by kind. */
export const KIND_STYLE: Record<BlockKind, { label: string; color: string }> = {
  start: { label: "Start", color: "#3fb950" },
  checkpoint: { label: "Checkpoint", color: "#4493f8" },
  finish: { label: "Finish", color: "#e5534b" },
  multilap: { label: "Start / finish", color: "#a371f7" },
};

export const ARROW: Record<string, string> = { North: "▲", East: "▶", South: "▼", West: "◀" };

/**
 * Checkpoints go pink in 3D and stay blue on the flat maps.
 *
 * Not inconsistency for its own sake: the ramp the 3D view shades height with
 * runs through blue, so a blue checkpoint vanished into the terrain exactly
 * where you most needed to find it. The flat views have grey blocks and no such
 * clash. Each view prints its own key, so neither can be misread.
 */
export const ISO_KIND_COLOR: Record<BlockKind, string> = {
  start: "#3fb950",
  checkpoint: "#ff4fa3",
  finish: "#e5534b",
  multilap: "#a371f7",
};

/** The MediaTracker trigger outline: white, never confused with a route marker. */
export const TRIGGER_COLOR = "rgba(255,255,255,.92)";

/** Low to high. A single hue family, so height reads as one ordered thing. */
export const HEIGHT_RAMP = ["#0d3b66", "#1d5b8f", "#2e7cb8", "#4fa3d1", "#7fc5e0", "#b8e0ed", "#ffd98a", "#ffb347"];

/** First block in the file to last: the bright half of a plasma-style scale. */
export const ORDER_RAMP = ["#5b3fd1", "#8a3fc4", "#b8429f", "#db5a7c", "#f07c5a", "#f9a43c", "#fbd130", "#f0f921"];

/** Interpolated rather than binned, so neighbours in time look like neighbours. */
export function orderFill(i: number, total: number): string {
  const t = total <= 1 ? 0 : i / (total - 1);
  const at = t * (ORDER_RAMP.length - 1);
  const k = Math.min(ORDER_RAMP.length - 2, Math.floor(at));
  const f = at - k;
  const a = parseInt(ORDER_RAMP[k].slice(1), 16);
  const b = parseInt(ORDER_RAMP[k + 1].slice(1), 16);
  const mix = (shift: number) => Math.round(((a >> shift) & 255) * (1 - f) + ((b >> shift) & 255) * f);
  return `#${((mix(16) << 16) | (mix(8) << 8) | mix(0)).toString(16).padStart(6, "0")}`;
}

/** The newest block while stepping through: white, the one value no ramp uses. */
export const NEWEST_COLOR = "#ffffff";

/** Blocks per second. The default aims a whole map at roughly half a minute. */
export const RATES = [5, 20, 100, 500];
export const defaultRate = (total: number) => RATES.find((r) => r >= total / 30) ?? RATES[RATES.length - 1];

export const heightColour = (top: number, minY: number, maxY: number) => {
  const t = maxY === minY ? 0.5 : (top - minY) / (maxY - minY);
  return HEIGHT_RAMP[Math.min(HEIGHT_RAMP.length - 1, Math.floor(t * HEIGHT_RAMP.length))];
};

// ---------------------------------------------------------------------------
// Plotting block names
// ---------------------------------------------------------------------------

/** Kept as the first colour in the palette, so a single pick looks unchanged. */
export const PLOT_COLOR = "#ffb347";

/** Told apart from each other first, and never the route colours. */
export const PLOT_PALETTE = [
  { hex: PLOT_COLOR, name: "Amber" },
  { hex: "#35d6c8", name: "Cyan" },
  { hex: "#ff5cc8", name: "Magenta" },
  { hex: "#b6f04a", name: "Lime" },
  { hex: "#f2f2f2", name: "White" },
  { hex: "#ff7043", name: "Coral" },
] as const;

/** Name -> the colour it is drawn in. Empty means nothing is plotted. */
export type Plotted = Map<string, string>;

/** Starting points, not answers: `sure` is false where the naming is a guess. */
export const PLOT_PRESETS: { id: string; label: string; match: string; sure: boolean }[] = [
  { id: "water", label: "Water & pools", match: "water|pool", sure: true },
  { id: "tunnels", label: "Tunnels & underground", match: "tunnel|underground|pipe", sure: false },
  { id: "checkpoints", label: "Checkpoints & gates", match: "checkpoint|gate", sure: true },
  { id: "turbo", label: "Turbo & boosters", match: "turbo|booster", sure: true },
  { id: "loops", label: "Loops & wallrides", match: "loop|wallride|wall", sure: false },
];

/** A bare word is a substring; anything with a pipe is the alternation it obviously is. */
export function filterNames<T extends { name: string }>(names: T[], filter: string): T[] {
  const q = filter.trim().toLowerCase();
  if (!q) return names;
  let test: (name: string) => boolean;
  try {
    const re = new RegExp(q, "i");
    test = (n) => re.test(n);
  } catch {
    test = (n) => n.toLowerCase().includes(q);
  }
  return names.filter((n) => test(n.name));
}

/**
 * The colour a *new* pick gets: the brush, unless that colour is already in
 * use and a free one exists. Past six the palette repeats.
 */
export function colourForNew(plotted: Plotted, brush: string): string {
  const used = new Set(plotted.values());
  if (!used.has(brush)) return brush;
  return PLOT_PALETTE.find((c) => !used.has(c.hex))?.hex ?? brush;
}

// ---------------------------------------------------------------------------
// The drawing grid
// ---------------------------------------------------------------------------

export interface IsoBlock {
  x: number;
  y: number;
  z: number;
  /** Set when this block is a route block or a plotted match; it stays solid. */
  mark?: string;
  /** A base colour in place of the height ramp, without marking the block. */
  fill?: string;
  /** "North" | "East" | "South" | "West" - drawn as an arrow on the top face. */
  dir?: string | null;
}

/**
 * Everything here is in **drawing** coordinates, not the file's.
 *
 * The two differ by a mirror on both axes - see `mx`/`mz` below - so nothing
 * in this object should ever be shown to the reader as a coordinate. The route
 * entries therefore keep the block itself alongside the position it is drawn
 * at.
 */
export interface Geometry {
  w: number;
  h: number;
  minY: number;
  maxY: number;
  cells: { x: number; z: number; top: number }[];
  /** One per block, **in file order** when `ordered`. */
  isoBlocks: IsoBlock[];
  /** Whether `isoBlocks` is the real block list rather than the footprint fallback. */
  ordered: boolean;
  /** For each entry of `route`, its position in the file, or -1 if unknown. */
  routeIndex: number[];
  /** Columns holding a block the reader asked to plot, and in which colour. */
  plottedCells: Map<string, string>;
  /** Columns a MediaTracker trigger sits in, already mirrored. */
  triggerCells: Set<string>;
  /** The same cells with their height, for the 3D view's hollow boxes. */
  triggerBoxes: { x: number; y: number; z: number }[];
  route: { b: SpecialBlock; x: number; z: number }[];
}

export function buildGeometry(data: Inspection, plotted: Plotted): Geometry | null {
  const cells = [...data.ground.cells.values()];
  if (cells.length === 0) return null;

  // The file says how big the map is; trust it, and only measure when it does
  // not. The size is a count and the coordinates are an index.
  const size = data.summary.size;
  const declared = Boolean(size && size.x > 0 && size.z > 0);
  const w = declared ? size!.x : Math.max(...cells.map((c) => c.x)) + 1;
  const h = declared ? size!.z : Math.max(...cells.map((c) => c.z)) + 1;

  // A block's stored x/z run the opposite way to how the editor shows them;
  // mirroring both axes is a 180 degree rotation, so north stays up. It
  // happens here and nowhere else, so the views cannot drift apart.
  const mx = (x: number) => w - 1 - x;
  const mz = (z: number) => h - 1 - z;

  // Flat views have one square per column: when two plotted kinds stack, the
  // higher one wins - it is the one you would see from above.
  const plottedCells = new Map<string, string>();
  if (plotted.size > 0) {
    const topAt = new Map<string, number>();
    for (const b of data.solid) {
      const colour = plotted.get(b.name);
      if (!colour) continue;
      const key = `${mx(b.x)},${mz(b.z)}`;
      const top = topAt.get(key);
      if (top !== undefined && top >= b.y) continue;
      topAt.set(key, b.y);
      plottedCells.set(key, colour);
    }
  }

  // A plotted block outranks the height shading but never a route block. When
  // the block list is missing the footprint stands in: a worse picture than
  // the real thing but an honest one.
  const routeAt = new Map(data.route.map((b) => [`${b.x},${b.z}`, ISO_KIND_COLOR[b.kind]]));
  const dirAt = new Map(data.route.map((b) => [`${b.x},${b.y},${b.z}`, b.direction]));
  const dirAtColumn = new Map(data.route.map((b) => [`${b.x},${b.z}`, b.direction]));
  const isoBlocks: IsoBlock[] =
    data.solid.length > 0
      ? data.solid.map((b) => ({
          x: mx(b.x),
          y: b.y,
          z: mz(b.z),
          mark: b.kind ? ISO_KIND_COLOR[b.kind] : plotted.get(b.name),
          dir: b.kind ? (dirAt.get(`${b.x},${b.y},${b.z}`) ?? null) : null,
        }))
      : cells.map((c) => ({
          x: mx(c.x),
          y: c.top,
          z: mz(c.z),
          mark: routeAt.get(`${c.x},${c.z}`),
          dir: dirAtColumn.get(`${c.x},${c.z}`) ?? null,
        }));

  const triggerCells = new Set<string>();
  const triggerBoxes: { x: number; y: number; z: number }[] = [];
  for (const t of data.triggers ?? []) {
    for (const c of t.coords) {
      triggerCells.add(`${mx(c.x)},${mz(c.z)}`);
      triggerBoxes.push({ x: mx(c.x), y: c.y, z: mz(c.z) });
    }
  }

  // `route` and `solid` are one pass over the same block list with the same
  // classifier, so the k-th route block is the k-th solid block with a kind.
  const routeIndex: number[] = [];
  data.solid.forEach((b, i) => {
    if (b.kind) routeIndex.push(i);
  });
  while (routeIndex.length < data.route.length) routeIndex.push(-1);

  return {
    w,
    h,
    ordered: data.solid.length > 0,
    routeIndex,
    triggerCells,
    triggerBoxes,
    minY: data.ground.minY,
    maxY: data.ground.maxY,
    cells: cells.map((c) => ({ x: mx(c.x), z: mz(c.z), top: c.top })),
    isoBlocks,
    plottedCells,
    route: data.route.map((b) => ({ b, x: mx(b.x), z: mz(b.z) })),
  };
}

/** One square per column for the first `shown` blocks, coloured by the top block's place in the file. */
export interface OrderCell {
  x: number;
  z: number;
  top: number;
  i: number;
}

export function columnsUpTo(g: Geometry, shown: number): OrderCell[] {
  const at = new Map<string, OrderCell>();
  for (let i = 0; i < shown && i < g.isoBlocks.length; i++) {
    const b = g.isoBlocks[i];
    const key = `${b.x},${b.z}`;
    const cur = at.get(key);
    if (!cur || b.y >= cur.top) at.set(key, { x: b.x, z: b.z, top: b.y, i });
  }
  return [...at.values()];
}

/**
 * The 3D view's blocks for a step of the build order: only the first `shown`,
 * optionally coloured by file order, the newest outlined in white unless it is
 * a route block.
 */
export function isoBlocksAt(g: Geometry, shown: number, byOrder: boolean): IsoBlock[] {
  const total = g.ordered ? g.isoBlocks.length : 0;
  const stepping = shown < total;
  if (!g.ordered || (!stepping && !byOrder)) return g.isoBlocks;
  const out: IsoBlock[] = [];
  for (let i = 0; i < shown; i++) {
    const b = g.isoBlocks[i];
    out.push({
      ...b,
      fill: byOrder ? orderFill(i, total) : undefined,
      mark: b.mark ?? (stepping && i === shown - 1 ? NEWEST_COLOR : undefined),
    });
  }
  return out;
}

/** Count of each route kind, for keys and lists. */
export function routeCounts(route: SpecialBlock[]): Partial<Record<BlockKind, number>> {
  const out: Partial<Record<BlockKind, number>> = {};
  for (const b of route) out[b.kind] = (out[b.kind] ?? 0) + 1;
  return out;
}
