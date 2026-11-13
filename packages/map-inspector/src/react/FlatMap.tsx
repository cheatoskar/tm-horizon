import type { SpecialBlock } from "../gbx.ts";
import {
  ARROW,
  heightColour,
  KIND_STYLE,
  NEWEST_COLOR,
  orderFill,
  TRIGGER_COLOR,
  type Geometry,
  type OrderCell,
} from "../view.ts";

/**
 * Top-down, filling whatever width it is given (`viewBox` plus `width: 100%`).
 *
 * All views draw the **declared** grid, not the blocks' bounding box: a 32x32
 * map looks like a 32x32 map, and an outlier looks like an outlier.
 *
 * From 100tmx.com (the `Flat` and `Marker` parts of MapViews.tsx).
 */
export function FlatMap({
  g,
  colour,
  showTriggers,
  order,
  frame = "rgba(127,127,127,.35)",
  label,
  kindLabel = (k) => KIND_STYLE[k].label,
}: {
  g: Geometry;
  colour: "track" | "height" | "order";
  showTriggers: boolean;
  /** Only on the order view: which columns exist so far, and the newest block. */
  order: { cells: OrderCell[]; shown: number; total: number; newest: { x: number; z: number } | null } | null;
  /** Stroke of the map's outline. */
  frame?: string;
  /** Accessible name of the drawing. */
  label?: string;
  /** Route kind names in the host's language (marker tooltips). */
  kindLabel?: (k: SpecialBlock["kind"]) => string;
}) {
  const cell = 11;
  const pad = 8;
  const width = g.w * cell + pad * 2;
  const height = g.h * cell + pad * 2;
  const colourByHeight = colour === "height";
  const route = g.route.filter((_, k) => !order || g.routeIndex[k] < order.shown);

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
      style={{ display: "block" }}
      role="img"
      aria-label={label ?? `${colour} map, ${g.w} by ${g.h} blocks`}
    >
      <rect x={pad} y={pad} width={g.w * cell} height={g.h * cell} fill="rgba(0,0,0,.24)" stroke={frame} strokeWidth={1} rx={3} />

      {order
        ? order.cells.map((c) => (
            <rect
              key={`${c.x},${c.z}`}
              x={pad + c.x * cell}
              y={pad + c.z * cell}
              width={cell - 1}
              height={cell - 1}
              rx={1.5}
              fill={orderFill(c.i, order.total)}
            />
          ))
        : null}
      {order?.newest ? (
        <rect
          x={pad + order.newest.x * cell - 1}
          y={pad + order.newest.z * cell - 1}
          width={cell + 1}
          height={cell + 1}
          rx={2}
          fill="none"
          stroke={NEWEST_COLOR}
          strokeWidth={1.6}
        />
      ) : null}

      {(order ? [] : g.cells).map((c) => (
        <rect
          key={`${c.x},${c.z}`}
          x={pad + c.x * cell}
          y={pad + c.z * cell}
          width={cell - 1}
          height={cell - 1}
          rx={1.5}
          fill={
            g.plottedCells.get(`${c.x},${c.z}`) ??
            (colourByHeight
              ? heightColour(c.top, g.minY, g.maxY)
              : // Quiet on purpose in the track view: the route markers are the subject.
                `rgba(255,255,255,${0.14 + ((c.top - g.minY) / Math.max(1, g.maxY - g.minY)) * 0.3})`)
          }
        />
      ))}

      {/* Triggers are an outline, never a fill, drawn under the route markers. */}
      {showTriggers
        ? [...g.triggerCells].map((key) => {
            const [tx, tz] = key.split(",").map(Number);
            return (
              <rect
                key={`trigger-${key}`}
                x={pad + tx * cell + 0.75}
                y={pad + tz * cell + 0.75}
                width={cell - 2.5}
                height={cell - 2.5}
                rx={1.5}
                fill="none"
                stroke={TRIGGER_COLOR}
                strokeWidth={1.25}
                strokeDasharray="2 1.6"
              />
            );
          })
        : null}

      {route.map((r, i) => (
        <Marker
          key={`${r.b.x},${r.b.z},${i}`}
          b={r.b}
          cx={pad + r.x * cell + (cell - 1) / 2}
          cy={pad + r.z * cell + (cell - 1) / 2}
          r={cell * 0.62}
          byHeight={colourByHeight}
          fill={colourByHeight ? heightColour(r.b.y, g.minY, g.maxY) : KIND_STYLE[r.b.kind].color}
          label={kindLabel(r.b.kind)}
        />
      ))}
    </svg>
  );
}

function Marker({
  b,
  cx,
  cy,
  r,
  fill,
  byHeight,
  label,
}: {
  b: SpecialBlock;
  cx: number;
  cy: number;
  r: number;
  fill: string;
  byHeight: boolean;
  label: string;
}) {
  const style = KIND_STYLE[b.kind];
  return (
    <g>
      <circle cx={cx} cy={cy} r={r} fill={fill} stroke="rgba(0,0,0,.6)" strokeWidth={1} />
      <text
        x={cx}
        y={cy}
        textAnchor="middle"
        dominantBaseline="central"
        fontSize={r * 1.15}
        fill={byHeight ? style.color : "#0b0b0b"}
        stroke={byHeight ? "rgba(0,0,0,.8)" : undefined}
        strokeWidth={byHeight ? r * 0.34 : undefined}
        paintOrder="stroke"
        style={{ fontWeight: 700 }}
      >
        {b.direction ? (ARROW[b.direction] ?? "•") : "•"}
      </text>
      <title>
        {label} - {b.x}, {b.y}, {b.z}
        {b.direction ? ` (${b.direction})` : ""}
      </title>
    </g>
  );
}
