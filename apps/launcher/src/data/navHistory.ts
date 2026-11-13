// In-app route history (hash routes) for the Back buttons: Back returns to the exact previous route (game
// page, search with its query, News, ...) and its scroll position; only with no previous route in this
// session (deep link, fresh start) does it fall back to the given page.
const stack: string[] = [location.hash || '#/'];
const scrolls = new Map<string, number>();
let goingBack = false;

const main = () => document.querySelector<HTMLElement>('main.main');
/** Last route of each sidebar section (like a browser tab), and a route opened from it whose scroll comes back. */
const lastOf = new Map<string, string>();
let restoreFor: string | null = null;

// The page re-renders after the route state changes: restore its scroll once it is there.
const restoreScroll = (to: string) => {
  const top = scrolls.get(to);
  if (top) for (const ms of [0, 60, 200, 500]) setTimeout(() => { const el = main(); if (el && el.scrollHeight > top) el.scrollTop = top; }, ms);
};

window.addEventListener('hashchange', (e) => {
  const from = new URL(e.oldURL).hash || '#/';
  const to = location.hash || '#/';
  const m = main();
  if (m) scrolls.set(from, m.scrollTop);
  if (stack.length > 1 && stack[stack.length - 2] === to) {
    stack.pop();
    restoreScroll(to);
  } else if (stack[stack.length - 1] !== to) {
    stack.push(to);
    if (restoreFor === to) restoreScroll(to);
  }
  restoreFor = null;
  goingBack = false;
});

/** Remembers the current route as the last one of a sidebar section. */
export function rememberSection(section: string, hash: string) { lastOf.set(section, hash || '#/'); }

/** Sidebar click: another section opens where it was left (route and scroll); the section already open goes to
 * its start (`start`). */
export function openSection(section: string, current: string, start: () => void) {
  const last = lastOf.get(section);
  if (section === current || !last) { lastOf.delete(section); start(); return; }
  restoreFor = last;
  location.hash = last.replace(/^#/, '');
}

/** Back to the previous route of this session, else to `fallback` (a page id for go()). */
export function goBack(fallback: () => void) {
  if (stack.length > 1 && !goingBack) {
    goingBack = true;
    history.back();
  } else {
    fallback();
  }
}

/** True when a Back button would return to an earlier route of this session. */
export const canGoBack = () => stack.length > 1;
