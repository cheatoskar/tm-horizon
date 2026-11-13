/// <reference types="vite/client" />
/** Set by vite.config.ts: true in the public release build (no preview-only art, see ART_CREDITS.md). */
declare const __PUBLIC_BUILD__: boolean;
/** Set by vite.config.ts: true in the "Launcher Preview" release (TMHUB_RELEASE_PREVIEW=1, implies the public build):
 * nothing that needs the TM Horizon Hub or our servers (sign-in, uploads, claims, server listing, event and
 * server submission, hub data). See docs/release/outbound-hosts.md. */
declare const __RELEASE_PREVIEW__: boolean;
