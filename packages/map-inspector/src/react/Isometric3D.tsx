import { useCallback, useEffect, useRef, useState } from "react";
import type { IsoBlock } from "../view.ts";

/**
 * The map as solid blocks, turned and zoomed with the mouse.
 *
 * Canvas rather than SVG: a rotation re-projects thousands of polygons per
 * frame. Still no WebGL and no library - an orthographic projection, backface
 * culling by winding, and a painter's sort is all this needs.
 *
 * Each block is drawn **where it actually sits**, floating if that is where the
 * author put it: the whole reason to look at a map in 3D is to find the
 * checkpoint hiding under a bridge.
 *
 * From 100tmx.com (src/components/tools/Isometric3D.tsx). Styling is the
 * host's: `className` on the wrapper, `buttonClassName` on the reset button.
 */

/**
 * A compass heading as a step in the **drawing** grid (the file's grid
 * mirrored on both axes, see `buildGeometry`): north is -z, east is +x.
 */
const DIR_STEP: Record<string, readonly [number, number]> = {
  North: [0, -1],
  East: [1, 0],
  South: [0, 1],
  West: [-1, 0],
};

export interface IsoInput {
  w: number;
  h: number;
  minY: number;
  maxY: number;
  blocks: IsoBlock[];
  /** MediaTracker trigger cells, drawn as open boxes. */
  triggers?: { x: number; y: number; z: number }[];
  /** Low-to-high ramp, so the drawing agrees with the height key. */
  ramp: string[];
}

// Straight down to straight up. Below zero the camera is under the map.
const MIN_PITCH = -Math.PI / 2;
const MAX_PITCH = Math.PI / 2;
const MIN_ZOOM = 0.35;
const MAX_ZOOM = 30;
const DEFAULT_PITCH = 0.62;

interface View {
  yaw: number;
  pitch: number;
  zoom: number;
  /** The point the camera orbits, in grid units; `null` = middle of the map at ground level. */
  target: { x: number; y: number; z: number } | null;
}

const initialView = (): View => ({ yaw: Math.PI / 4, pitch: DEFAULT_PITCH, zoom: 1, target: null });

/** The world directions that move one pixel right and one pixel down on screen, per unit of scale. */
function screenAxes(yaw: number, pitch: number) {
  const cosY = Math.cos(yaw);
  const sinY = Math.sin(yaw);
  const cosP = Math.cos(pitch);
  const sinP = Math.sin(pitch);
  return {
    right: { x: cosY, y: 0, z: -sinY },
    down: { x: sinY * sinP, y: -cosP, z: cosY * sinP },
  };
}

function shade(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.min(255, Math.round(((n >> 16) & 255) * amount));
  const g = Math.min(255, Math.round(((n >> 8) & 255) * amount));
  const b = Math.min(255, Math.round((n & 255) * amount));
  return `rgb(${r},${g},${b})`;
}

export function Isometric3D({
  input,
  ghost,
  height = 460,
  className,
  buttonClassName,
  resetLabel = "Reset view",
  ariaLabel = "The map drawn as blocks. Drag to move it, right-drag or shift-drag to turn it, scroll to zoom.",
}: {
  input: IsoInput;
  /** Fade everything that is not marked, so the marked blocks show through it. */
  ghost: boolean;
  height?: number;
  className?: string;
  buttonClassName?: string;
  resetLabel?: string;
  ariaLabel?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const view = useRef<View>(initialView());
  /** Every pointer currently down, so two fingers can pan and pinch. */
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  /** Whether the one-pointer drag in progress moves the map rather than turning it. */
  const panning = useRef(false);
  /** Pixels per grid unit at the last draw, which a pan or zoom is measured in. */
  const lastScale = useRef(1);
  const frame = useRef<number | null>(null);
  const [grabbing, setGrabbing] = useState(false);

  const draw = useCallback(() => {
    frame.current = null;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cw = canvas.clientWidth;
    const ch = height;
    if (canvas.width !== cw * dpr || canvas.height !== ch * dpr) {
      canvas.width = cw * dpr;
      canvas.height = ch * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);

    const { w, h, minY, maxY, blocks, ramp, triggers } = input;
    const { yaw, pitch, zoom } = view.current;
    const target = (view.current.target ??= { x: w / 2, y: minY, z: h / 2 });
    const cosY = Math.cos(yaw);
    const sinY = Math.sin(yaw);
    const cosP = Math.cos(pitch);
    const sinP = Math.sin(pitch);
    // Looking up from underneath, every "top" below swaps to the bottom of the block.
    const below = pitch < 0;

    // The footprint's diagonal, so the map never clips as it turns.
    const diagonal = Math.hypot(w, h);
    const span = Math.max(1, maxY - minY) + 1;
    const fit = Math.min((cw * 0.92) / diagonal, (ch * 0.92) / (diagonal * Math.abs(sinP) + span * cosP));
    const scale = fit * zoom;
    lastScale.current = scale;
    const ox = cw / 2;
    const oy = ch / 2;

    const project = (x: number, y: number, z: number) => {
      const cx = x - target.x;
      const cz = z - target.z;
      const cy = y - target.y;
      const rx = cx * cosY - cz * sinY;
      const rz = cx * sinY + cz * cosY;
      return {
        sx: ox + rx * scale,
        sy: oy + (rz * sinP - cy * cosP) * scale,
      };
    };

    const depthOf = (b: IsoBlock) => {
      const cx = b.x - w / 2;
      const cz = b.z - h / 2;
      const rz = cx * sinY + cz * cosY;
      return rz * cosP + (b.y - minY) * sinP;
    };

    // Far first, so near blocks paint over them.
    const ordered = [...blocks].sort((a, b) => depthOf(a) - depthOf(b));

    const colourFor = (y: number) => {
      const t = maxY === minY ? 0.5 : (y - minY) / (maxY - minY);
      return ramp[Math.min(ramp.length - 1, Math.floor(t * ramp.length))];
    };

    for (const b of ordered) {
      const marked = Boolean(b.mark);
      // Ghosting is what makes a buried checkpoint findable.
      ctx.globalAlpha = ghost && !marked ? 0.22 : 1;

      const base = b.mark ?? b.fill ?? colourFor(b.y);
      const y1 = b.y + 1;
      const y0 = b.y;

      const corners = [
        [b.x, b.z],
        [b.x + 1, b.z],
        [b.x + 1, b.z + 1],
        [b.x, b.z + 1],
      ] as const;

      for (let i = 0; i < 4; i++) {
        const [ax, az] = corners[i];
        const [bx, bz] = corners[(i + 1) % 4];
        const p1 = project(ax, y1, az);
        const p2 = project(bx, y1, bz);
        const p3 = project(bx, y0, bz);
        const p4 = project(ax, y0, az);

        // Backface culling: canvas y grows downward, so the visible face is the
        // one whose projected winding comes out negative; zero is edge-on.
        const area = (p2.sx - p1.sx) * (p3.sy - p1.sy) - (p3.sx - p1.sx) * (p2.sy - p1.sy);
        if (area >= 0) continue;

        ctx.beginPath();
        ctx.moveTo(p1.sx, p1.sy);
        ctx.lineTo(p2.sx, p2.sy);
        ctx.lineTo(p3.sx, p3.sy);
        ctx.lineTo(p4.sx, p4.sy);
        ctx.closePath();
        ctx.fillStyle = shade(base, i % 2 === 0 ? 0.62 : 0.44);
        ctx.fill();
      }

      const lid = below ? y0 : y1;
      const t1 = project(b.x, lid, b.z);
      const t2 = project(b.x + 1, lid, b.z);
      const t3 = project(b.x + 1, lid, b.z + 1);
      const t4 = project(b.x, lid, b.z + 1);
      ctx.beginPath();
      ctx.moveTo(t1.sx, t1.sy);
      ctx.lineTo(t2.sx, t2.sy);
      ctx.lineTo(t3.sx, t3.sy);
      ctx.lineTo(t4.sx, t4.sy);
      ctx.closePath();
      ctx.fillStyle = below ? shade(base, 0.32) : base;
      ctx.fill();
      if (marked) {
        ctx.strokeStyle = "rgba(0,0,0,.6)";
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      // Which way the block faces, on its lid, painted in the same sort so a
      // bridge covers it like it covers the block. Not from underneath.
      const step = b.dir && !below ? DIR_STEP[b.dir] : undefined;
      if (step) {
        const [dx, dz] = step;
        const px = -dz;
        const pz = dx;
        const cx2 = b.x + 0.5;
        const cz2 = b.z + 0.5;
        const at = (alongT: number, acrossT: number) =>
          project(cx2 + dx * alongT + px * acrossT, y1, cz2 + dz * alongT + pz * acrossT);

        const tip = at(0.44, 0);
        const barbL = at(-0.2, 0.32);
        const notch = at(-0.04, 0);
        const barbR = at(-0.2, -0.32);

        ctx.beginPath();
        ctx.moveTo(tip.sx, tip.sy);
        ctx.lineTo(barbL.sx, barbL.sy);
        ctx.lineTo(notch.sx, notch.sy);
        ctx.lineTo(barbR.sx, barbR.sy);
        ctx.closePath();
        ctx.fillStyle = "rgba(0,0,0,.82)";
        ctx.fill();
        ctx.strokeStyle = "rgba(255,255,255,.45)";
        ctx.lineWidth = 0.75;
        ctx.stroke();
      }
    }
    // Trigger boxes last, hollow and unlit, so they read as a marked region.
    if (triggers && triggers.length > 0) {
      ctx.globalAlpha = 1;
      ctx.strokeStyle = "rgba(255,255,255,.85)";
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 2]);
      for (const t of triggers) {
        const lo = t.y;
        const hi = t.y + 1;
        const corner = [
          [t.x, t.z],
          [t.x + 1, t.z],
          [t.x + 1, t.z + 1],
          [t.x, t.z + 1],
        ] as const;

        ctx.beginPath();
        corner.forEach(([cx, cz], i) => {
          const p = project(cx, below ? lo : hi, cz);
          if (i === 0) ctx.moveTo(p.sx, p.sy);
          else ctx.lineTo(p.sx, p.sy);
        });
        ctx.closePath();
        ctx.stroke();

        for (const [cx, cz] of corner) {
          const a = project(cx, hi, cz);
          const b = project(cx, lo, cz);
          ctx.beginPath();
          ctx.moveTo(a.sx, a.sy);
          ctx.lineTo(b.sx, b.sy);
          ctx.stroke();
        }
      }
      ctx.setLineDash([]);
    }

    ctx.globalAlpha = 1;
  }, [input, ghost, height]);

  const schedule = useCallback(() => {
    if (frame.current === null) frame.current = requestAnimationFrame(draw);
  }, [draw]);

  useEffect(() => {
    schedule();
    const onResize = () => schedule();
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
    };
  }, [schedule]);

  /** Shift the target so the map follows the pointer by (dx, dy) pixels. */
  const panBy = useCallback((dx: number, dy: number) => {
    const t = view.current.target;
    if (!t) return;
    const { right, down } = screenAxes(view.current.yaw, view.current.pitch);
    const k = 1 / lastScale.current;
    t.x -= (right.x * dx + down.x * dy) * k;
    t.y -= (right.y * dx + down.y * dy) * k;
    t.z -= (right.z * dx + down.z * dy) * k;
  }, []);

  /** Zoom by `factor`, keeping whatever sits under (px, py) where it is. */
  const zoomAt = useCallback(
    (factor: number, px: number, py: number) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const before = lastScale.current;
      const zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, view.current.zoom * factor));
      const after = (before / view.current.zoom) * zoom;
      view.current.zoom = zoom;
      const rect = canvas.getBoundingClientRect();
      const u = px - rect.left - rect.width / 2;
      const v = py - rect.top - rect.height / 2;
      lastScale.current = before;
      panBy(-u * (1 - before / after), -v * (1 - before / after));
      lastScale.current = after;
      schedule();
    },
    [panBy, schedule],
  );

  // Wheel has to be a non-passive listener to stop the page scrolling under the cursor.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY);
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  const reset = () => {
    view.current = initialView();
    schedule();
  };

  /** The two-finger gesture's midpoint and spread, or null with fewer than two. */
  const pinch = () => {
    const [a, b] = [...pointers.current.values()];
    if (!a || !b) return null;
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) };
  };

  const release = (id: number) => {
    pointers.current.delete(id);
    if (pointers.current.size === 0) {
      panning.current = false;
      setGrabbing(false);
    }
  };

  return (
    <div className={className} style={{ position: "relative" }}>
      <canvas
        ref={canvasRef}
        style={{
          width: "100%",
          height,
          display: "block",
          cursor: grabbing ? "grabbing" : "grab",
          touchAction: "none",
        }}
        aria-label={ariaLabel}
        role="img"
        // The right button turns the map, so the menu it would open has to go.
        onContextMenu={(e) => e.preventDefault()}
        onPointerDown={(e) => {
          pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
          // Mouse: left moves the map, right (or shift) turns it. Touch: one
          // finger turns, two move and pinch.
          panning.current = e.pointerType === "mouse" && e.button !== 2 && !e.shiftKey;
          setGrabbing(true);
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const prev = pointers.current.get(e.pointerId);
          if (!prev) return;
          const before = pinch();
          pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

          if (before) {
            const after = pinch()!;
            panBy(after.x - before.x, after.y - before.y);
            if (before.d > 0) zoomAt(after.d / before.d, after.x, after.y);
            schedule();
            return;
          }

          const dx = e.clientX - prev.x;
          const dy = e.clientY - prev.y;
          if (panning.current) {
            panBy(dx, dy);
          } else {
            view.current.yaw += dx * 0.01;
            view.current.pitch = Math.max(MIN_PITCH, Math.min(MAX_PITCH, view.current.pitch + dy * 0.006));
          }
          schedule();
        }}
        onPointerUp={(e) => {
          release(e.pointerId);
          e.currentTarget.releasePointerCapture(e.pointerId);
        }}
        onPointerCancel={(e) => release(e.pointerId)}
      />
      <button type="button" onClick={reset} className={buttonClassName} style={{ position: "absolute", right: 8, top: 8 }}>
        {resetLabel}
      </button>
    </div>
  );
}
