# Own covers from my screenshots

Optional override for **Nations ESWC, Sunrise and Original**: my own in-game screenshots (for example
TMVS photos) as cover and page header, in TM Horizon's style. Without files here the launcher and the
website keep today's look (official cover from IGDB/Steam, else the designed cover).

1. Put the screenshots into `drop/` (this folder never ships; `vite.config.ts` removes it from the build):
   - `eswc-cover.jpg`, `eswc-hero.jpg`
   - `tms-cover.jpg`, `tms-hero.jpg`
   - `tmo-cover.jpg`, `tmo-hero.jpg`

   jpg, png or webp, any size. Cover = portrait (cut to 600x900, gets the game name), hero = wide
   (cut to 1920x620, only a dark fade: the game page writes the name on it). Pick pictures with the
   important part in the middle; the top of a cover stays clear, the name sits in the lower third.
2. Run from the repo root: `python -I apps/launcher/tools/make-own-covers.py` (needs Pillow).
3. It writes `<game>-cover.jpg` / `<game>-hero.jpg` here and in `apps/web/public/img/covers-own/`, and
   `apps/launcher/src/generated/covers-own.json` (which games have one). Check the pictures, then commit
   the composed files and the JSON (not `drop/`).
4. To go back: empty `drop/` and run the script again; it removes the composed files.

Only screenshots I made myself go here (my own work); no box scans or other people's pictures.
