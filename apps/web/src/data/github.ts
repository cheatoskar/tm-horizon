// "All TrackMania projects on GitHub": the list scripts/build-github-projects.mjs wrote (hub discovery + catalog repositories).
// The file is generated and ignored by git; without it the page is empty rather than the build failing.
export interface GithubProject {
  repo: string; name: string; description: string | null; url: string; stars: number; language: string | null; games: string[]; pushed: string | null;
  archived: boolean; topics: string[]; from: 'hub' | 'catalog';
}
const files = import.meta.glob('./github-projects.json', { eager: true, import: 'default' }) as Record<string, { generated: string; items: GithubProject[] }>;
const file = Object.values(files)[0];
export const githubProjects: GithubProject[] = file?.items ?? [];
export const githubProjectsGenerated: string | null = file?.generated ?? null;
