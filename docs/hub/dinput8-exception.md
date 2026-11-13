# dinput8.dll exception

The release checks reject every `dinput8.dll` (`type.dinput8`): it is a proxy DLL, StarForce-protected games break with it,
and it is the usual carrier of copy-protection bypass loaders.

One exception, for the author's own loader (ESWC Autosave / Legacy Essentials and the Legacy Randomizer), in
`apps/server/src/checks/dinput8.ts` (`DINPUT8_ALLOWED`). It applies only when **all** of this match: the release comes from the
listed GitHub repository (origin `github:<owner>/<repo>@<tag>`), the hub project id matches (once the project exists, its id goes
into the list; until then the repository and a claimed project count), and the project is claimed. Never by name.
Everything else keeps the rejection. The allowed file gets an info finding `type.dinput8.allowed` instead.

**Field in the signed index** (`HubIndexVersion.starForceBlocked?: string[]`, `packages/shared/src/hub.ts`): paths inside the zip of
files the launcher must never install into a StarForce-protected game. Present only on a version that carries such an allowed
file. The launcher enforces it (it skips these files for such games or refuses the install for them); older launchers ignore the
field, so the file must not be offered to them for those games either (the project lists only the games it supports).

`scripts/recheck-dinput8.ts` removes versions that were rejected only because of `dinput8.dll` for the allowed projects, marks their
releases unseen, checks the sources again and re-signs the index (`npm run recheck-dinput8`). Tests: `test/dinput8.test.ts`,
`test/checks.test.ts`.
