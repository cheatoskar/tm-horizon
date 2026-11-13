// Typo-tolerant search without a dependency: every word of the query has to match some word of
// the item (exact, prefix, substring or within a small Damerau-Levenshtein distance); the score
// rewards matches in the name over author, tags and description.

const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
const words = (s: string) => norm(s).split(/[^a-z0-9]+/).filter(Boolean);

/** Optimal-string-alignment distance (Damerau-Levenshtein without repeated edits), stops early above `max`. */
export function distance(a: string, b: string, max = 3): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const m = a.length;
  const n = b.length;
  let prev2: number[] = [];
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev2 = prev;
    prev = cur;
  }
  return prev[n];
}

/** Cost of matching one query word against one item word: 0 = exact/prefix, 1 = substring, 2-4 = typos; null = no match. */
function wordCost(q: string, w: string): number | null {
  if (w === q) return 0;
  if (w.startsWith(q)) return 0.2;
  if (q.length >= 3 && w.includes(q)) return 1;
  const tol = q.length <= 3 ? 0 : q.length <= 6 ? 1 : 2;
  if (!tol) return null;
  // Typo in the word itself, or in the start of a longer word ("trackmnia" vs "trackmaniaforever").
  const d = Math.min(distance(q, w, tol), w.length > q.length ? distance(q, w.slice(0, q.length), tol) + 0.5 : tol + 1);
  return d <= tol ? 2 + d : null;
}

export interface FuzzyField { text: string; weight: number }

/** Higher is better; null when a query word matches nowhere. An empty query matches everything with 0. */
export function fuzzyScore(query: string, fields: FuzzyField[]): number | null {
  const qs = words(query);
  if (!qs.length) return 0;
  const fw = fields.map((f) => ({ weight: f.weight, words: words(f.text), whole: norm(f.text) }));
  let total = 0;
  for (const q of qs) {
    let best = -1;
    for (const f of fw) {
      let cost: number | null = f.whole.includes(q) ? 1 : null;
      for (const w of f.words) {
        const c = wordCost(q, w);
        if (c !== null && (cost === null || c < cost)) cost = c;
      }
      if (cost !== null) best = Math.max(best, f.weight * (6 - Math.min(cost, 5)));
    }
    if (best < 0) return null;
    total += best;
  }
  return total;
}
