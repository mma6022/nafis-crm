import { getCollection, type CollectionEntry } from 'astro:content';
import { CATEGORIES, tagSlug, type CategoryKey } from '../data/blog-taxonomy';

export type Post = CollectionEntry<'blog'>;
export const POSTS_PER_PAGE = 12;

/** Published posts, newest first. Drafts are visible only in `astro dev`. */
export async function getPosts(): Promise<Post[]> {
  const posts = await getCollection('blog', ({ data }) => import.meta.env.DEV || !data.draft);
  return posts.sort((a, b) => b.data.date.getTime() - a.data.date.getTime());
}

/** page paths end with `/` (trailingSlash 'always'), the form nginx serves without a 301 */
export const postPath = (p: Post) => `/blog/${p.id}/`;
export const categoryPath = (c: CategoryKey) => `/blog/category/${c}/`;
export const tagPath = (t: string) => `/blog/tag/${tagSlug(t)}/`;
export const categoryLabel = (c: CategoryKey) => CATEGORIES[c].label;

/** Reading time in minutes = words / 200 (designer build_site.py: tags and MDX comments removed, min 1). */
export function readingMinutes(body: string | undefined): number {
  const words = (body ?? '').replace(/<[^>]+>|\{\/\*[\s\S]*?\*\/\}/g, ' ').split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 200));
}

/** Related posts (designer build_site.py): same category first (newest first), then the home picks, then the rest. */
export function relatedPosts(post: Post, all: Post[], limit = 3): Post[] {
  const byDate = [...all].sort((a, b) => b.data.date.getTime() - a.data.date.getTime());
  const same = byDate.filter((p) => p.id !== post.id && p.data.category === post.data.category);
  const out = [...same, ...homePosts(all), ...byDate].filter((p) => p.id !== post.id);
  return [...new Set(out)].slice(0, limit);
}

/** All tags with their display label (first spelling seen) and posts. */
export function collectTags(posts: Post[]) {
  const map = new Map<string, { label: string; posts: Post[] }>();
  for (const p of posts)
    for (const t of p.data.tags) {
      const s = tagSlug(t);
      if (!map.has(s)) map.set(s, { label: t, posts: [] });
      map.get(s)!.posts.push(p);
    }
  return map;
}

/** Home «مجله نفیس» (designer build_site.py): newest first, pillar first on equal dates, one per category, 3 posts. */
export function homePosts(posts: Post[], n = 3): Post[] {
  const sorted = [...posts].sort((a, b) => b.data.date.getTime() - a.data.date.getTime() || Number(b.data.pillar) - Number(a.data.pillar));
  const seen = new Set<string>();
  const picks = sorted.filter((p) => !seen.has(p.data.category) && !!seen.add(p.data.category));
  return [...picks, ...sorted.filter((p) => !picks.includes(p))].slice(0, n);
}
/** Cover-template title: the part before «؛ ? ؟» (designer post_card). */
export const thumbTitle = (t: string) => t.split('؛')[0]!.split('?')[0]!.split('؟')[0]!.trim();
