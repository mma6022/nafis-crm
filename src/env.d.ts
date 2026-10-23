/// <reference types="astro/client" />
declare namespace App {
  interface Locals {
    /** FAQ items of the page being rendered (MDX <FAQ />) */
    faq?: { q: string; a: string }[];
    /** headings of the post being rendered (MDX <TOC />) */
    headings?: { depth: number; slug: string; text: string }[];
    /** lead line for blog inline CTAs */
    ctaLead?: string;
    /** ids already used by <PlanFinder> on this page */
    finderIds?: Set<string>;
  }
}
