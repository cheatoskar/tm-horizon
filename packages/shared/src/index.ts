// @tm-hub/shared: what the launcher, the website and the data pipeline agree on.
// types.ts = the shapes of packages/api/dist/*.json, tokens.ts = the design tokens (tokens.css for CSS).
export type * from './types.ts';
export { tokens, type Tokens } from './tokens.ts';
export { REPO, repoUrl, issueFormUrl, issueDraft, ISSUE_TEMPLATES, type IssueKind, type IssueFields } from './repo.ts';
// hub.ts = the TM Horizon Hub (signed index, API objects of apps/server and apps/portal).
export type * from './hub.ts';
export { HUB_INSTALL_TYPES, HUB_GAMES, HUB_CATEGORIES, HUB_PROJECT_TYPES, PROJECT_TYPES, isProjectType, projectTypeOfCatalog, REPORT_REASONS, HUB_INDEX_SIG_PREFIX, HUB_AUTHOR_SIG_PREFIX, authorSigMessage, installOfType, typeOfInstall } from './hub.ts';
export { RELATED_KINDS, MAX_RELATED, isRelatedKind, cleanHttpsUrl, cleanRelatedLink, cleanRelatedLinks, sortRelated, type RelatedKind, type RelatedLink } from './links.ts';
// showcase.ts = the format of mod showcase pages (types, limits, allowlists, validator); showcase-md.ts = its limited Markdown.
export * from './showcase.ts';
export { HORIZON_MODULES, HORIZON_MODULE_NAMES, horizonPluginName, isHorizonModule } from './horizon.ts';
