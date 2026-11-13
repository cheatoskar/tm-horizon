// Logos of catalog projects: downloaded once into the hub's storage through the same picture checks as an
// upload (format by bytes, size limits, metadata stripped). Never replaces a picture somebody put there.
import type { Ctx } from '../ctx.ts';
import { downloadAsset } from '../sources/github.ts';
import { storeImage } from './images.ts';

/** kv key: the author uploaded or removed the project's icon; from then on the icon belongs to the author. */
export const authorIconKey = (projectId: string) => `icon.author.${projectId}`;

/** Marks the icon as the author's (an upload or a removal in the portal); catalog re-imports leave it alone. */
export async function markIconByAuthor(ctx: Ctx, projectId: string): Promise<void> {
  await ctx.db.insertInto('kv').values({ key: authorIconKey(projectId), value: new Date().toISOString() }).onConflict((oc) => oc.column('key').doUpdateSet({ value: new Date().toISOString() })).execute();
}

/** Sets the icon of a project from a URL when it has none and the author never touched it. Returns true when an icon was stored; any failure just means "no icon". */
export async function ensureIcon(ctx: Ctx, projectId: string, url: string | null | undefined): Promise<boolean> {
  if (!url) return false;
  try {
    const has = await ctx.db.selectFrom('images').select('id').where('project_id', '=', projectId).where('kind', '=', 'icon').executeTakeFirst();
    if (has) return false;
    // Removed (or set) by the author: a re-import must not bring the catalog logo back.
    if (await ctx.db.selectFrom('kv').select('key').where('key', '=', authorIconKey(projectId)).executeTakeFirst()) return false;
    const data = await downloadAsset(ctx, url, ctx.cfg.MAX_IMAGE_MB * 1048576);
    await storeImage(ctx, projectId, 'icon', data, 0, null);
    return true;
  } catch {
    return false;
  }
}
