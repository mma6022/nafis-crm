import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';
import { CATEGORY_KEYS } from './data/blog-taxonomy';

const blog = defineCollection({
  // The glob loader uses frontmatter `slug` as the entry id → /blog/<slug>
  loader: glob({ pattern: '**/*.{md,mdx}', base: './src/content/blog' }),
  schema: ({ image }) =>
    z.object({
      title: z.string().min(5).max(90),
      description: z.string().min(50).max(170), // meta description length
      slug: z
        .string()
        .regex(
          /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
          'slug must be lowercase latin kebab-case (URL-safe), e.g. "loan-without-guarantor"',
        ),
      date: z.coerce.date(),
      updated: z.coerce.date().optional(),
      author: z.string().default('تیم نفیس وام'),
      category: z.enum(CATEGORY_KEYS),
      tags: z.array(z.string()).default([]),
      cover: image().optional(),
      coverAlt: z.string().optional(),
      draft: z.boolean().default(false),
      sample: z.boolean().default(false), // placeholder posts — shown with a "نمونه" badge, noindex
    }),
});

export const collections = { blog };
