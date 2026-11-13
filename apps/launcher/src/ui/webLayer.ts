// The embedded browser (Maps, Skins, TAS sites) is a separate native child webview on top of the app's
// own webview: no HTML can be drawn over it. Anything that would overlap it has to move it instead:
// - dialogs (ui/Modal.tsx) register as open overlays; pages/Embedded.tsx hides the view while one is open;
// - the sidebar's hover labels (ui/shell.tsx) never move the page: while an embedded view is showing they
//   are drawn in a small native tooltip window above it (src-tauri/src/tipwin.rs).

let overlays = 0;
const inset = 0;
let embedded = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((f) => f());

export const onWebLayer = (f: () => void) => { listeners.add(f); return () => { listeners.delete(f); }; };
export const overlayOpen = () => overlays > 0;
export const webInset = () => inset;

/** A dialog opened (returns the close function). */
export function openOverlay(): () => void {
  overlays++;
  emit();
  let closed = false;
  return () => { if (closed) return; closed = true; overlays = Math.max(0, overlays - 1); emit(); };
}

/** An embedded view is on screen (Embedded.tsx): hover labels over it need the native tooltip window. */
export const setEmbedded = (on: boolean) => { embedded = on; };
export const embeddedOpen = () => embedded;

/** The view's rectangle with the inset applied. */
export function insetRect(r: DOMRect): DOMRect {
  if (!inset) return r;
  const i = Math.min(inset, Math.max(0, r.width - 200));
  return new DOMRect(r.left + i, r.top, r.width - i, r.height);
}
