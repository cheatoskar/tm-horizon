// GitHub issue forms of the hub repository (packages/shared/src/repo.ts). Entries are reviewed by hand
// and appear after approval. While the repository is not public the links are null: the pages show a
// disabled button with the note "available after the first release".
import { REPO, issueFormUrl } from '@tm-hub/shared';

export const formsOpen = REPO.public;
export const forms = {
  event: formsOpen ? issueFormUrl('event') : null,
  server: formsOpen ? issueFormUrl('server') : null,
};
