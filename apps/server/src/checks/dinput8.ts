// dinput8.dll is rejected everywhere (it is a proxy DLL: StarForce-protected games break, and it is the usual
// carrier of loaders that bypass copy protection). The one exception is the author's own loader for a game without
// StarForce (ESWC Autosave / Legacy Essentials, Legacy Randomizer). It is allowed only when BOTH match: the hub project
// id (when known) and the GitHub repository the release came from (origin "github:<owner>/<repo>@<tag>"), and the
// project is claimed. Never by name. A version that carries the file gets `starForceBlocked` in the signed index
// (the file names): the launcher must never install those files into a StarForce game (hub.ts, HubIndexVersion).
export interface Dinput8Entry {
  /** Hub project id; null while the project does not exist yet (then only the repository and the claim count). */
  projectId: string | null;
  /** Lower-case "owner/repo" of the release source. */
  repo: string;
}

export const DINPUT8_ALLOWED: Dinput8Entry[] = [
  { projectId: 'p_7cyfbx7p963ysz', repo: 'cheatoskar/eswc-autosave' },
  // Same project after the rename eswc-autosave -> legacy-essentials (GitHub redirects the old name).
  { projectId: 'p_7cyfbx7p963ysz', repo: 'cheatoskar/legacy-essentials' },
  { projectId: null, repo: 'cheatoskar/legacy-randomizer' },
];

export function dinput8Allowed(project: { id: string; claimed: number | boolean | null }, origin: string, list: Dinput8Entry[] = DINPUT8_ALLOWED): boolean {
  if (!project.claimed) return false;
  const m = /^github:([^@]+)@/.exec(origin);
  if (!m) return false;
  const repo = m[1]!.toLowerCase();
  return list.some((e) => e.repo === repo && (e.projectId === null || e.projectId === project.id));
}
