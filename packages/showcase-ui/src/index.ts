// @tm-hub/showcase-ui: renders a Showcase (packages/shared/src/showcase.ts). Import the styles once:
// `import '@tm-hub/showcase-ui/showcase.css'`. For static pages (the website) use renderToStaticMarkup(<ShowcaseView/>)
// and call enhanceShowcases() from '@tm-hub/showcase-ui/enhance' in the browser for the slider and the video buttons.
export { ShowcaseView, Md, DEFAULT_LABELS, type ShowcaseCtx, type ShowcaseLabels, type ShowcaseRelease } from './Showcase.tsx';
export { ReadmeView, type ReadmeViewProps } from './ReadmeView.tsx';
export { renderReadme, slug, BADGE, type ReadmeOptions } from './readme.ts';
