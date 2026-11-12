/** JSON-LD builders. Output is injected with <JsonLd> in the <head>. */
import { CONTACT, SITE, WORK_HOURS, absoluteUrl } from './site';
import { stripMarkers } from './markers';

export type Crumb = { name: string; path: string };

const pad = (h: number) => `${String(h).padStart(2, '0')}:00`;
/** Sat–Thu 09:00–18:00 (Mohammad 2026-10-23). ContactPoint carries the company landline (v1.2) + email + /contact. */
export const openingHoursLd = () => ({
  '@type': 'OpeningHoursSpecification',
  dayOfWeek: [...WORK_HOURS.schemaDays],
  opens: pad(WORK_HOURS.start),
  closes: pad(WORK_HOURS.end),
});

export const organizationLd = () => ({
  '@context': 'https://schema.org',
  '@type': 'Organization',
  '@id': `${SITE.url}/#organization`,
  name: SITE.name,
  alternateName: SITE.nameEn,
  legalName: SITE.legalName,
  url: SITE.url,
  sameAs: [SITE.instagram, CONTACT.baleUrl],
  logo: { '@type': 'ImageObject', url: absoluteUrl(SITE.logoPng), width: 2000, height: 364 },
  image: absoluteUrl(SITE.ogImage),
  email: SITE.email,
  address: { '@type': 'PostalAddress', ...SITE.addressParts },
  contactPoint: [
    {
      '@type': 'ContactPoint',
      telephone: CONTACT.phoneE164,
      email: SITE.email,
      url: absoluteUrl('/contact/'),
      contactType: 'customer service',
      areaServed: 'IR',
      availableLanguage: ['fa'],
      hoursAvailable: openingHoursLd(),
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
  image: absoluteUrl(SITE.ogImage),
  email: SITE.email,
  areaServed: { '@type': 'Country', name: 'Iran' },
  parentOrganization: { '@id': `${SITE.url}/#organization` },
  openingHoursSpecification: [openingHoursLd()],
  address: { '@type': 'PostalAddress', ...SITE.addressParts },
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
    logo: { '@type': 'ImageObject', url: absoluteUrl(SITE.logoPng) },
  },
  image: absoluteUrl(a.image ?? SITE.ogImage),
  articleSection: a.category,
  keywords: a.tags.join(', '),
  inLanguage: 'fa-IR',
});
