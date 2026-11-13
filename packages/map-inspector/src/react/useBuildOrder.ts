import { useEffect, useState } from "react";
import { defaultRate } from "../view.ts";

/**
 * Stepping through the block list in the order the file stores it: how many
 * blocks are shown, play/pause at `rate` blocks a second, stopping at the end
 * (the finished map is the thing to look at). Resets when `key` changes (a
 * different map).
 *
 * From 100tmx.com (the scrubber state in MapViews.tsx).
 */
export function useBuildOrder(total: number, key: unknown) {
  const [shownRaw, setShown] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(() => defaultRate(total));
  const [forKey, setForKey] = useState(key);
  if (forKey !== key) {
    setForKey(key);
    setShown(null);
    setPlaying(false);
    setRate(defaultRate(total));
  }
  const shown = Math.min(total, shownRaw ?? total);
  const stepping = shown < total;

  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    let carry = 0;
    const tick = (now: number) => {
      carry += ((now - last) / 1000) * rate;
      last = now;
      const step = Math.floor(carry);
      if (step > 0) {
        carry -= step;
        setShown((v) => Math.min(total, (v ?? total) + step));
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, rate, total]);

  if (playing && shown >= total) setPlaying(false);

  return {
    shown,
    total,
    stepping,
    playing,
    rate,
    setRate,
    /** Jump to `n` blocks (stops playback); `total` or more = the whole map. */
    seek(n: number) {
      setPlaying(false);
      setShown(n >= total ? null : Math.max(0, n));
    },
    toggle() {
      if (playing) return setPlaying(false);
      if (shown >= total) setShown(0);
      setPlaying(true);
    },
  };
}
