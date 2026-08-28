/**
 * Splits a profile page into per-section fragments.
 *
 * The profile page shows only the first few entries of each section behind a
 * "Show all N" link, and every section renders with the same card markup — so
 * harvesting the page as a whole yields one undifferentiated pile. LinkedIn marks
 * each section start with an empty anchor whose `id` names it (`<div id="experience">`),
 * and that anchor is a routing target, not styling, so it is stable across deploys.
 */
import * as cheerio from 'cheerio';
import { SECTION_KEYS, SECTION_ROUTES, type SectionKey } from '../../schema/profile.js';

/** Anchor ids LinkedIn uses, where they differ from our section key. */
const ANCHOR_IDS: Record<SectionKey, string[]> = {
  experience: ['experience'],
  education: ['education'],
  skills: ['skills'],
  certifications: ['licenses_and_certifications', 'certifications'],
  languages: ['languages'],
  projects: ['projects'],
  honors: ['honors_and_awards', 'honors'],
  volunteer: ['volunteering_experience', 'volunteer_experience', 'volunteering'],
  publications: ['publications'],
  courses: ['courses'],
  organizations: ['organizations'],
};

export type SectionFragments = Partial<Record<SectionKey, string>>;

export function segmentProfile(html: string): SectionFragments {
  const $ = cheerio.load(html);
  const fragments: SectionFragments = {};

  for (const key of SECTION_KEYS) {
    for (const id of ANCHOR_IDS[key]) {
      const anchor = $(`#${id}`).first();
      if (anchor.length === 0) continue;

      // The anchor sits inside the section it labels; the section element is the
      // smallest container holding both it and the entry list.
      const section = anchor.closest('section');
      const scope = section.length > 0 ? section : anchor.parent();
      const fragment = $.html(scope);
      if (fragment && fragment.length > 0) {
        fragments[key] = fragment;
        break;
      }
    }
  }

  return fragments;
}

/**
 * Sections with a "Show all" link, i.e. the ones whose full contents require a
 * details-page fetch. Sections rendered complete on the profile page are excluded
 * so we spend requests only where they buy data.
 */
export function sectionsWithMore(html: string): Set<SectionKey> {
  const found = new Set<SectionKey>();
  const routeToKey = new Map<string, SectionKey>(
    SECTION_KEYS.map((k) => [SECTION_ROUTES[k], k]),
  );

  for (const match of html.matchAll(/\/details\/([a-z-]+)\//g)) {
    const key = routeToKey.get(match[1] ?? '');
    if (key) found.add(key);
  }
  return found;
}
