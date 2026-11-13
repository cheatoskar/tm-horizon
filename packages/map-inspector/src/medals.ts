/**
 * Medal times, both directions.
 *
 * TrackMania derives the bronze, silver and gold medals from the author time by
 * fixed ratios, so three of the four numbers on a map are a consequence of the
 * fourth. Going forwards is exact. Going back is not - the medals are rounded
 * up to whole seconds when they are generated, so the author time they came
 * from can only be recovered approximately, and averaging the three estimates
 * is the best you can do.
 *
 * The ratios and the rounding are Weregoose's, lifted from the spreadsheet the
 * community has used for this, and checked against his own worked examples:
 *
 *   1:00:00.69  ->  gold 1:03:37.00  silver 1:12:01.00  bronze 1:30:02.00
 *   gold 0:34:43.00  silver 0:39:18.00  bronze 0:49:07.00  ->  ~0:32:45.00
 */

/** Gold, silver and bronze as multiples of the author time. */
export const MEDAL_RATIO = { gold: 1.06, silver: 1.2, bronze: 1.5 } as const;

export interface Medals {
  gold: number;
  silver: number;
  bronze: number;
}

/**
 * Author time -> the other three.
 *
 * The game rounds each medal **up** to a whole second, which is why 1:30:01.04
 * is published as 1:30:02 rather than 1:30:01. Rounding to nearest would be off
 * by a second on roughly half of all maps.
 */
export function medalsFromAuthor(authorMs: number): Medals {
  const up = (ratio: number) => Math.ceil((authorMs * ratio) / 1000) * 1000;
  return { gold: up(MEDAL_RATIO.gold), silver: up(MEDAL_RATIO.silver), bronze: up(MEDAL_RATIO.bronze) };
}

/**
 * The other three -> an approximate author time.
 *
 * Each medal gives an estimate; they disagree slightly because each was rounded
 * up independently, so the average of the three is closer than any one of them.
 * The result is snapped to the nearest half second, which is honest about the
 * precision rather than printing three decimals it has not got.
 *
 * Any medal may be left out - a map with only a gold time still gives an
 * estimate, just a worse one. Null when none were supplied.
 */
export function authorFromMedals(m: Partial<Medals>): number | null {
  const estimates: number[] = [];
  if (m.gold) estimates.push(m.gold / MEDAL_RATIO.gold);
  if (m.silver) estimates.push(m.silver / MEDAL_RATIO.silver);
  if (m.bronze) estimates.push(m.bronze / MEDAL_RATIO.bronze);
  if (estimates.length === 0) return null;
  const mean = estimates.reduce((a, b) => a + b, 0) / estimates.length;
  return Math.round(mean / 500) * 500;
}

export interface MedalCheck {
  medal: "gold" | "silver" | "bronze";
  expected: number;
  actual: number;
  /** Signed, in milliseconds. Positive means the file is slower than it should be. */
  offBy: number;
  ok: boolean;
}

/**
 * Do a map's medals agree with its author time?
 *
 * In TrackMania 1 the three medals are *generated* from the author time - they
 * are not typed in - so on an untouched map they always come out at exactly
 * `ceil(author x ratio)`. When they do not, the times in the file have been
 * edited after the fact, which is the usual signature of a faked author time.
 * This is Weregoose's check, and it is the reason the tool existed: it is how
 * you tell a map whose author time nobody could ever have driven.
 *
 * It is evidence, not a verdict. A one-second disagreement can be a different
 * game version's rounding; a wildly impossible author time with medals that
 * still match is a cheat this cannot see at all. Both are said out loud rather
 * than hidden behind a red flag.
 */
export function checkMedals(authorMs: number, actual: Partial<Medals>): MedalCheck[] {
  const expected = medalsFromAuthor(authorMs);
  const out: MedalCheck[] = [];
  for (const medal of ["gold", "silver", "bronze"] as const) {
    const have = actual[medal];
    if (!have) continue;
    const want = expected[medal];
    out.push({ medal, expected: want, actual: have, offBy: have - want, ok: have === want });
  }
  return out;
}

/**
 * Read a time the way a person would type it.
 *
 * Accepts `h:mm:ss.cc`, `m:ss.cc`, `ss.cc` and anything in between, because the
 * times people paste come from the game, from TMX and from each other and none
 * of them agree on a format. Returns milliseconds, or null if it is not a time.
 */
export function parseTime(input: string): number | null {
  const text = input.trim().replace(",", ".");
  if (!text) return null;
  if (!/^\d+(:\d{1,2})*(\.\d{1,3})?$/.test(text)) return null;

  const [whole, fraction = ""] = text.split(".");
  const parts = whole.split(":").map(Number);
  if (parts.some((p) => !Number.isFinite(p))) return null;
  if (parts.length > 3) return null;

  // Right to left: seconds, then minutes, then hours.
  let seconds = 0;
  for (const part of parts) seconds = seconds * 60 + part;

  const millis = Number((fraction + "000").slice(0, 3));
  return seconds * 1000 + millis;
}

/**
 * Print a time the way the game does.
 *
 * Hours only appear when there are any - `raceTime` in `format.ts` is the
 * site's own convention and prints a one-hour map as `60:00.690`, which is
 * right for a leaderboard and wrong on a page about medal times.
 */
export function formatTime(ms: number, decimals: 2 | 3 = 2): string {
  if (!Number.isFinite(ms) || ms < 0) return "-";
  const total = Math.round(ms);
  const hours = Math.floor(total / 3_600_000);
  const minutes = Math.floor((total % 3_600_000) / 60_000);
  const seconds = Math.floor((total % 60_000) / 1000);
  const frac = String(total % 1000).padStart(3, "0").slice(0, decimals);
  const mm = hours > 0 ? String(minutes).padStart(2, "0") : String(minutes);
  return `${hours > 0 ? `${hours}:` : ""}${mm}:${String(seconds).padStart(2, "0")}.${frac}`;
}

/**
 * The medal colours, in one place.
 *
 * Author is **green**, because the author coin is green - the label has to
 * agree with the picture beside it. The medal converter used `--accent` for
 * it, which is the exchange tint: red on TMNF, blue on TMUF, yellow on TMN.
 * A medal is not a brand colour and does not change per exchange.
 */
export const MEDAL_COLORS = {
  bronze: "#cd7f32",
  silver: "#cecece",
  gold: "#ffc83c",
  author: "#3fb950",
} as const;
