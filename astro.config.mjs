import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';
import tailwindcss from '@tailwindcss/vite';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tagSlug } from './src/data/blog-taxonomy.ts';

const SITE = 'https://nafisvam.com';

/**
 * Sitemap hygiene, read straight from the blog frontmatter at config time:
 *  - posts marked `sample: true` / `draft: true` are noindex → not in the sitemap;
 *  - category/tag archives that contain only such posts are noindex too → not in the sitemap.
 */
const blogDir = fileURLToPath(new URL('./src/content/blog/', import.meta.url));
const hiddenPostPaths = new Set();
const indexedCategories = new Set();
const indexedTags = new Set();
if (fs.existsSync(blogDir)) {
  for (const f of fs.readdirSync(blogDir).filter((f) => /\.mdx?$/.test(f))) {
    const fm = fs.readFileSync(blogDir + f, 'utf8').split(/^---$/m)[1] ?? '';
    const slug = fm.match(/^slug:\s*["']?([^"'\n]+)["']?/m)?.[1]?.trim();
    if (/^(sample|draft):\s*true/m.test(fm)) {
      if (slug) hiddenPostPaths.add(`/blog/${slug}`);
      continue;
    }
    const category = fm.match(/^category:\s*["']?([^"'\n]+)["']?/m)?.[1]?.trim();
    if (category) indexedCategories.add(category);
    const tags = fm.match(/^tags:\s*\[(.*)\]/m)?.[1] ?? '';
    for (const t of tags.split(',')) {
      const tag = t.trim().replace(/^["']|["']$/g, '');
      if (tag) indexedTags.add(tagSlug(tag));
    }
  }
}
function inSitemap(path) {
  if (path.endsWith('/404') || /\/\d+$/.test(path) || hiddenPostPaths.has(path)) return false;
  const cat = path.match(/^\/blog\/category\/([^/]+)$/)?.[1];
  if (cat) return indexedCategories.has(cat);
  const tag = path.match(/^\/blog\/tag\/([^/]+)$/)?.[1];
  if (tag) return indexedTags.has(decodeURIComponent(tag));
  return true;
}
const snapshotPath = fileURLToPath(new URL('./src/data/loan-plans.snapshot.json', import.meta.url));

/**
 * In dev, serve the build-time snapshot at /data/loan-plans.json so islands fetch the same path
 * they use in production. In production the CRM maintains the real file on the server, so the
 * build intentionally does NOT ship a copy (it would shadow the live data).
 */
function devLoanPlans() {
  return {
    name: 'nafis-dev-loan-plans',

    /** @param {{ middlewares: { use: (p: string, h: (req: unknown, res: import('node:http').ServerResponse) => void) => void } }} server */
    configureServer(server) {
      server.middlewares.use('/data/loan-plans.json', (_req, res) => {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(fs.readFileSync(snapshotPath));
      });
    },
  };
}

export default defineConfig({
  site: SITE,
  output: 'static',
  trailingSlash: 'never',
  build: { format: 'directory', inlineStylesheets: 'auto' },
  integrations: [
    react(),
    mdx(),
    sitemap({
      // no 404, no paginated archives (/blog/2, …), no sample/draft posts or archives made only of them
      filter: (page) => inSitemap(new URL(page).pathname.replace(/\/$/, '')),
    }),
  ],
  vite: {
    plugins: [tailwindcss(), devLoanPlans()],
  },
});
