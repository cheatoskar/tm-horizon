// Developer docs: Markdown files in src/content/dev (synced from the source repositories by scripts/sync-dev-docs.mjs,
// plus a few hand-written pages). See src/views/DevDoc.astro.
import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const dev = defineCollection({
  loader: glob({ pattern: '*.md', base: './src/content/dev' }),
  schema: z.object({
    title: z.string(),
    group: z.enum(['tutorials', 'publish', 'plugins', 'examples', 'porting', 'api']),
    order: z.number(),
    synced: z.boolean().default(false),
    sourceRepo: z.string().optional(),
    sourceBranch: z.string().optional(),
    sourceCommit: z.string().optional(),
    sourcePath: z.string().optional(),
    editUrl: z.string().url().optional(),
    note: z.string().optional(),
  }),
});

export const collections = { dev };
