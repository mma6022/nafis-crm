/** JSON-LD builders. Output is injected with <JsonLd> in the <head>. */
import { SITE, absoluteUrl } from './site';
import { stripMarkers } from './markers';

export type Crumb = { name: string; path: string };

export const organizationLd = () => ({
  '@context': 'https://schema.org',
  '@type': 'Organization',
  '@id': `${SITE.url}/#organization`,
  name: SITE.name,
  alternateName: SITE.nameEn,
  url: SITE.url,
  logo: absoluteUrl(SITE.logoPng),
  email: SITE.email,
  telephone: SITE.phoneE164,
  contactPoint: [
    {
      '@type': 'ContactPoint',
      telephone: SITE.phoneE164,
      contactType: 'customer service',
      areaServed: 'IR',
      availableLanguage: ['fa'],
    },
  ],
});

export const financialServiceLd = () => ({
  '@context': 'https://schema.org',
  '@type': 'FinancialService',
  '@id': `${SITE.url}/#service`,
  name: SITE.name,
  description: SITE.description,
  url: SITE.url,
  image: absoluteUrl(SITE.logoPng),
  telephone: SITE.phoneE164,
  email: SITE.email,
  areaServed: { '@type': 'Country', name: 'Iran' },
  parentOrganization: { '@id': `${SITE.url}/#organization` },
  // TODO(spec): address, openingHours, priceRange once confirmed by Mohammad
});

export const websiteLd = () => ({
  '@context': 'https://schema.org',
  '@type': 'WebSite',
  '@id': `${SITE.url}/#website`,
  name: SITE.name,
  url: SITE.url,
  inLanguage: 'fa-IR',
  publisher: { '@id': `${SITE.url}/#organization` },
});

/** FAQPage JSON-LD. Placeholder markers are stripped (they stay visible on the page). */
export const faqLd = (items: { q: string; a: string }[], path?: string) => ({
  '@context': 'https://schema.org',
  '@type': 'FAQPage',
  ...(path ? { url: absoluteUrl(path) } : {}),
  mainEntity: items.map((i) => ({
    '@type': 'Question',
    name: stripMarkers(i.q),
    acceptedAnswer: { '@type': 'Answer', text: stripMarkers(i.a) },
  })),
});

export const breadcrumbLd = (crumbs: Crumb[]) => ({
  '@context': 'https://schema.org',
  '@type': 'BreadcrumbList',
  itemListElement: crumbs.map((c, i) => ({
    '@type': 'ListItem',
    position: i + 1,
    name: c.name,
    item: absoluteUrl(c.path),
  })),
});

export const articleLd = (a: {
  title: string;
  description: string;
  path: string;
  date: Date;
  updated?: Date;
  author: string;
  image?: string;
  category: string;
  tags: string[];
}) => ({
  '@context': 'https://schema.org',
  '@type': 'Article',
  headline: a.title,
  description: a.description,
  mainEntityOfPage: { '@type': 'WebPage', '@id': absoluteUrl(a.path) },
  url: absoluteUrl(a.path),
  datePublished: a.date.toISOString(),
  dateModified: (a.updated ?? a.date).toISOString(),
  author: { '@type': 'Person', name: a.author },
  publisher: {
    '@id': `${SITE.url}/#organization`,
    '@type': 'Organization',
    name: SITE.name,
    logo: { '@type': 'ImageObject', url: absoluteUrl(SITE.logo) },
  },
  image: absoluteUrl(a.image ?? SITE.ogImage),
  articleSection: a.category,
  keywords: a.tags.join(', '),
  inLanguage: 'fa-IR',
});
