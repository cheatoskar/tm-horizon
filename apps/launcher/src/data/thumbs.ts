// Media page pictures: small JPEGs made by the app (media_thumb), never the original files in the grid.
// Requests run a few at a time, first come first served; a card that scrolls away before its turn
// takes its request back. Finished URLs are kept for the session, so coming back to the page is instant.
import { convertFileSrc, invoke } from '@tauri-apps/api/core';

export interface ThumbSource { path: string; size: number; modified: string | null }

const MAX_RUNNING = 4;
const ready = new Map<string, string>();
const failed = new Set<string>();
interface Job { key: string; src: ThumbSource; view: boolean; done: (url: string) => void; fail: () => void; dropped: boolean }
const queue: Job[] = [];
let running = 0;

const keyOf = (s: ThumbSource, view: boolean) => `${view ? 'v' : 't'}|${s.path}|${s.size}|${s.modified ?? ''}`;

export const readyThumb = (s: ThumbSource, view = false) => ready.get(keyOf(s, view));
export const thumbFailed = (s: ThumbSource, view = false) => failed.has(keyOf(s, view));

function pump() {
  while (running < MAX_RUNNING && queue.length) {
    const job = queue.shift()!;
    if (job.dropped) continue;
    running++;
    invoke<string>('media_thumb', { path: job.src.path, view: job.view })
      .then((p) => { const url = convertFileSrc(p); ready.set(job.key, url); job.done(url); })
      .catch(() => { failed.add(job.key); job.fail(); })
      .finally(() => { running--; pump(); });
  }
}

/** Asks for the picture; returns a function that withdraws the request if it has not started yet. */
export function requestThumb(src: ThumbSource, view: boolean, done: (url: string) => void, fail: () => void): () => void {
  const key = keyOf(src, view);
  const have = ready.get(key);
  if (have) { done(have); return () => {}; }
  if (failed.has(key)) { fail(); return () => {}; }
  const job: Job = { key, src, view, done, fail, dropped: false };
  // the viewer's picture goes first
  if (view) queue.unshift(job); else queue.push(job);
  pump();
  return () => { job.dropped = true; job.done = () => {}; job.fail = () => {}; };
}
