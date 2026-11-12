import rss from '@astrojs/rss';
import type { APIRoute } from 'astro';
import { getPosts, postPath, categoryLabel } from '../lib/blog';
import { SITE } from '../lib/site';

export const GET: APIRoute = async ({ site }) => {
  const posts = (await getPosts()).filter((p) => !p.data.sample);
  return rss({
    title: `مجله ${SITE.name}`,
    description: 'آموزش وام، تسهیلات، بازپرداخت و سواد مالی به زبان ساده.',
    site: site!,
    items: posts.map((p) => ({
      title: p.data.title,
      description: p.data.description,
      pubDate: p.data.date,
      link: postPath(p),
      categories: [categoryLabel(p.data.category), ...p.data.tags],
      author: p.data.author,
    })),
    customData: '<language>fa-ir</language>',
  });
};
