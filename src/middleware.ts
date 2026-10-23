/** Final-HTML pass: placeholder markers → bracketless pills with `data-marker` (src/lib/ph-html.ts). */
import { defineMiddleware } from 'astro:middleware';
import { pillMarkers } from './lib/ph-html';

export const onRequest = defineMiddleware(async (_ctx, next) => {
  const res = await next();
  if (!res.headers.get('content-type')?.includes('text/html')) return res;
  const html = pillMarkers(await res.text());
  return new Response(html, { status: res.status, statusText: res.statusText, headers: res.headers });
});
