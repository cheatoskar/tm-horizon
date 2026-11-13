// README of a mod's GitHub repository as static HTML for the mod pages (same renderer as the launcher and the portal,
// packages/showcase-ui). Pictures only through the same-origin proxy (/ext-img/); badges and other pictures it does not
// serve are left out. The page already shows the mod's name as its title, so a README's first H1 that repeats it goes.
import { renderReadme } from '@tm-hub/showcase-ui/readme';
import { webImg } from '@tm-hub/shared/extimg';

export const readmeHtml = (readme: string, repo: string | null, title: string): string =>
  renderReadme(readme, { repo, title, imageUrl: (u) => webImg(u), newTab: true });
