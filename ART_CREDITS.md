# Art credits

**Public builds leave the preview-only art out.** Release builds (`TMHUB_PUBLIC_BUILD=1`, or
`npm run build:public` in `apps/launcher`) contain none of: `public/header-art/` (TMX Headers Contest 2022),
and the box covers `public/store-art/*/cover.*`. The UI does not
reference them there and the files are deleted from `dist/`. A plain `npm run build` (preview) keeps them.
See `docs/release.md`.

## TMX Headers Contest 2022

Header banners and environment backgrounds from the TMX Headers Contest 2022, converted to webp by
`apps/launcher/scanner/import-header-art.py` into `apps/launcher/public/header-art/`.

**local/preview only until TMX and the artists agree — ask before a public release.**
The images are not part of the website (`apps/web`).

| Converted file | Artist | Source file (in "2022 TMX Headers Contest") |
|---|---|---|
| `banner-tmnf-day.webp` | shortz | `Headers/TMNF/shortz1-day.png` |
| `banner-tmnf-night.webp` | shortz | `Headers/TMNF/shortz1-night.png` |
| `banner-tmuf-day.webp` | Dule | `Headers/United/Bay/Dule-Bay-Day.png` |
| `banner-tmuf-night.webp` | Dule | `Headers/United/Bay/Dule-Bay-Night.png` |
| `env-bay-day.webp` | Dule | `Headers/Dule-BayDayBG.jpg` |
| `env-bay-night.webp` | Dule | `Headers/Dule-BayNightBG.jpg` |
| `env-bay-small.webp` | Dule | `Headers/Dule-BayDayBG.jpg (480 px version)` |
| `env-coast-day.webp` | Dule | `Headers/Dule-CoastDayBG.jpg` |
| `env-coast-night.webp` | Dule | `Headers/Dule-CoastNightBG.jpg` |
| `env-coast-small.webp` | Dule | `Headers/Dule-CoastDayBG.jpg (480 px version)` |
| `env-desert-day.webp` | Dule | `Headers/Dule-DesertDayBG.jpg` |
| `env-desert-night.webp` | Dule | `Headers/Dule-DesertNightBG.jpg` |
| `env-desert-small.webp` | Dule | `Headers/Dule-DesertDayBG.jpg (480 px version)` |
| `env-island-day.webp` | Dule | `Headers/Dule-IslandDayBG.jpg` |
| `env-island-night.webp` | Dule | `Headers/DuleIslandNightBG.jpg` |
| `env-island-small.webp` | Dule | `Headers/Dule-IslandDayBG.jpg (480 px version)` |
| `env-rally-day.webp` | Dule | `Headers/Dule-RallyDayBG.jpg` |
| `env-rally-night.webp` | Dule | `Headers/Dule-RallyNightBG.jpg` |
| `env-rally-small.webp` | Dule | `Headers/Dule-RallyDayBG.jpg (480 px version)` |
| `env-snow-day.webp` | Dule | `Headers/Dule-SnowDayBG.jpg` |
| `env-snow-night.webp` | Dule | `Headers/Dule-SnowNightBG.jpg` |
| `env-snow-small.webp` | Dule | `Headers/Dule-SnowDayBG.jpg (480 px version)` |
| `env-stadium-day.webp` | Dule | `Headers/Dule-StadiumDayBG.jpg` |
| `env-stadium-night.webp` | Dule | `Headers/Dule-StadiumNightBG.jpg` |
| `env-stadium-small.webp` | Dule | `Headers/Dule-StadiumDayBG.jpg (480 px version)` |

## Nations ESWC (launcher tile and hero)

- `apps/launcher/public/store-art/tmn-eswc/hero.jpg`: my own screenshot (TM Vibrant Shaders photo mode, `photo_045.png`,
  2560x1440, scaled to 1600x900), since 0.5.0. In public builds too.
- `apps/launcher/public/store-art/tmn-eswc/cover.jpg`: owner-supplied box scan (unchanged).
- Not used: `trackmanianations.jpg` (640x480, too small for a hero) and `3404239_original.jpg` (it shows
  TrackMania Sunrise, not Nations).

## Site icons

Fallback icons in `apps/launcher/public/site-icons/<host>.png` (downscaled to 64 px; used when the live favicon fetch fails). The logos belong to their sites; they only identify the site in the site switcher.

- tmnf.exchange, tmuf.exchange, nations.tm-exchange.com, original.tm-exchange.com, sunrise.tm-exchange.com: https://images.mania.exchange/logos/tm1x/logo_sq.png
- trackmania.exchange: https://images.mania.exchange/logos/tmx/square_sm.png
- tm.mania.exchange, sm.mania.exchange: https://images.mania.exchange/logos/mx/square_sm.png
- item.exchange, item.mania.exchange: https://item.exchange/ixicon.png
- tmtas.exchange: https://tmtas.exchange/favicon.png
- tmrpgtrial.com: https://ssl.maniacdn.net/malun22/tmtrial/ressources/trialleaderboard_60.png
- maniapark.com: https://images.mania-exchange.com/logos/mp/logo.png
