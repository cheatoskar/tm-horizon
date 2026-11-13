/**
 * The map inspector's core, shared by 100tmx.com/tools/map-inspector and the
 * TM Horizon launcher's "Map details".
 *
 * Origin: the website's src/lib/tools (gbx.ts, medals.ts, lzo1x.ts, read-gbx.ts),
 * src/workers/gbx.worker.ts and src/components/tools (MapViews.tsx,
 * Isometric3D.tsx, BlockPlotter.tsx), as of website commit 2c6deef. The pure
 * parts are copied unchanged; the React parts lost their Tailwind classes and
 * take labels from the host, so each site keeps its own design around them.
 *
 * Licence note, load-bearing: `gbx` (MIT) decompresses a map body with a
 * hard-coded `await import("lzo-ts")`, and `lzo-ts` is GPL-3.0. Every host
 * aliases `lzo-ts` to `./lzo1x.ts` (`@tm-hub/map-inspector/lzo1x`), an
 * independent LZO1X decompressor with the same `LZO` export, so no GPL code is
 * bundled. The website does it in next.config.ts, the launcher in
 * vite.config.ts.
 */

export * from "./gbx.ts";
export * from "./medals.ts";
export * from "./view.ts";
