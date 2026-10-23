import { getCollection, type CollectionEntry } from 'astro:content';
import readingTime from 'reading-time';
import { CATEGORIES, tagSlug, type CategoryKey } from '../data/blog-taxonomy';

export type Post = CollectionEntry<'blog'>;
export const POSTS_PER_PAGE = 12;

/** Published posts, newest first. Drafts are visible only in `astro dev`. */
export async function getPosts(): Promise<Post[]> {
  const posts = await getCollection('blog', ({ data }) => import.meta.env.DEV || !data.draft);
  return posts.sort((a, b) => b.data.date.getTime() - a.data.date.getTime());
}

export const postPath = (p: Post) => `/blog/${p.id}`;
export const categoryPath = (c: CategoryKey) => `/blog/category/${c}`;
export const tagPath = (t: string) => `/blog/tag/${tagSlug(t)}`;
export const categoryLabel = (c: CategoryKey) => CATEGORIES[c].label;

/** Persian reading time, e.g. "۴ دقیقه مطالعه". ~200 wpm suits Persian prose. */
export function readingMinutes(body: string | undefined): number {
  return Math.max(1, Math.round(readingTime(body ?? '', { wordsPerMinute: 200 }).minutes));
}

/** Related posts: shared tags ×2 + same category ×3, then recency. */
export function relatedPosts(post: Post, all: Post[], limit = 3): Post[] {
  const tags = new Set(post.data.tags.map(tagSlug));
  return all
    .filter((p) => p.id !== post.id)
    .map((p) => ({
      p,
      score:
        (p.data.category === post.data.category ? 3 : 0) + p.data.tags.filter((t) => tags.has(tagSlug(t))).length * 2,
    }))
    .sort((a, b) => b.score - a.score || b.p.data.date.getTime() - a.p.data.date.getTime())
    .slice(0, limit)
    .map((x) => x.p);
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
