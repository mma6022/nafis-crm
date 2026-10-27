import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';
import { categoryKey } from './data/blog-taxonomy';

/** `a` may use fact tokens and rate tokens ({rateMain} {rateLow} {rateLowCount} {rateLowNames}); `aNoRate` = the
 *  no-number answer used when the rate is unknown/stale (default lib/rates RATE_FAQ_FALLBACK). lib/faq-fill.ts */
const faq = z.array(z.object({ q: z.string().min(5), a: z.string().min(10), aNoRate: z.string().min(10).optional() })).default([]);

const blog = defineCollection({
  // The glob loader uses frontmatter `slug` as the entry id → /blog/<slug>
  loader: glob({ pattern: '**/*.{md,mdx}', base: './src/content/blog' }),
  schema: ({ image }) =>
    z.object({
      title: z.string().min(5).max(90),
      /** visible H1 when it differs from the <title> (copy B1–B3); defaults to title */
      h1: z.string().optional(),
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
      category: z.string().transform((v, ctx) => {
        const k = categoryKey(v);
        if (!k) ctx.addIssue({ code: 'custom', message: `unknown category «${v}» (add it to src/data/blog-taxonomy.ts)` });
        return k!;
      }),
      tags: z.array(z.string()).default([]),
      cover: image().optional(),
      coverAlt: z.string().optional(),
      keywords: z.array(z.string()).default([]),
      relatedPlans: z.array(z.number()).default([]),
      faq, // rendered as a visible FAQ section + FAQPage JSON-LD
      draft: z.boolean().default(false),
      pillar: z.boolean().default(false), // home «مجله نفیس» lists the pillar post first
      sample: z.boolean().default(false), // placeholder posts — shown with a "نمونه" badge, noindex
    }),
});

const cta = z.object({ text: z.string(), href: z.string() });

/** Keyword landing pages + home copy (from nafis-site-ux/content/pages). Title/h1 may contain {planCount} / {goodsCount}. */
const pages = defineCollection({
  loader: glob({ pattern: '*.mdx', base: './src/content/pages' }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    slug: z.string(),
    h1: z.string(),
    h1Variants: z.array(z.string()).optional(),
    primaryKeyword: z.string(),
    /** Hero lead under the H1 (landings). Supports **bold**, fact tokens and markers. */
    lead: z.string().optional(),
    secondaryKeywords: z.array(z.string()).default([]),
    planFilter: z.string().optional(),
    relatedPlans: z.array(z.number()).nullable().default([]),
    cta: z.object({ primary: cta, secondary: cta.optional() }),
    faq,
  }),
});

export const collections = { blog, pages };
