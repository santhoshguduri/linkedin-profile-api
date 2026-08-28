/**
 * Extraction orchestrator: URL in, validated Profile out.
 *
 * Acquisition order, cheapest and most reliable first:
 *   1. The profile page — identity, topcard, about, images, and the first few
 *      entries of every section.
 *   2. /details/<section>/ pages, but only for sections the profile page showed a
 *      "Show all" link for. Sections rendered complete cost no extra request.
 *
 * Every stage is allowed to fail on its own. A section that cannot be reached is
 * named in `meta.missingSections` and the rest of the profile still returns —
 * a partial profile is far more useful than an error.
 */
import type { Logger } from 'pino';
import type { Config } from '../../config.js';
import { AppError } from '../../util/errors.js';
import { mapWithConcurrency } from '../../util/ratelimit.js';
import {
  ProfileSchema,
  SECTION_KEYS,
  SECTION_ROUTES,
  type Profile,
  type SectionKey,
} from '../../schema/profile.js';
import type { LinkedInFetcher } from '../fetcher.js';
import { profileUrlFor } from '../url.js';
import {
  fetchContactInfoPage,
  fetchDetailsPage,
  fetchProfilePage,
  type DecodedPage,
} from '../pages/profilePage.js';
import { harvestEntities, type RawEntity } from './entities.js';
import { extractIdentity, extractProfileImages, extractTopcard } from './topcard.js';
import { extractAbout } from './about.js';
import { extractContactInfo, isEmptyContact } from './contact.js';
import { segmentProfile, sectionsWithMore } from './segment.js';
import {
  dedupeEntities,
  isMeaningful,
  toCertification,
  toEducation,
  toExperience,
  toGenericEntry,
  toLanguage,
  toSkill,
} from './sections.js';

export interface ExtractionResult {
  profile: Profile;
  sources: string[];
  missingSections: string[];
  warnings: string[];
}

/** Maps harvested cards onto the typed shape for a given section. */
function mapSection(key: SectionKey, entities: RawEntity[]): unknown[] {
  const usable = dedupeEntities(entities.filter(isMeaningful));
  switch (key) {
    case 'experience':
      return usable.map(toExperience);
    case 'education':
      return usable.map(toEducation);
    case 'skills':
      return usable.map(toSkill).filter(Boolean);
    case 'certifications':
      return usable.map(toCertification);
    case 'languages':
      return usable.map(toLanguage).filter(Boolean);
    default:
      return usable.map(toGenericEntry);
  }
}

export interface PageExtraction {
  identity: ReturnType<typeof extractIdentity>;
  topcard: ReturnType<typeof extractTopcard>;
  images: ReturnType<typeof extractProfileImages>;
  about: string | null;
  sections: Map<SectionKey, unknown[]>;
}

/**
 * Everything the profile page alone yields — no network, no fallbacks.
 *
 * Split out from the orchestrator so the same code path can be run offline
 * against a saved capture (`npm run decode`). An extraction bug is then
 * reproducible from a file rather than only against live LinkedIn.
 */
export function extractFromProfileHtml(html: string, tree: unknown): PageExtraction {
  const identity = extractIdentity(tree, html);
  const fragments = segmentProfile(html);
  const sections = new Map<SectionKey, unknown[]>();

  for (const key of SECTION_KEYS) {
    const fragment = fragments[key];
    if (!fragment) continue;
    const mapped = mapSection(key, harvestEntities(fragment, null));
    if (mapped.length > 0) sections.set(key, mapped);
  }

  return {
    identity,
    topcard: extractTopcard(tree, html, identity),
    images: extractProfileImages(tree, html, identity),
    about: extractAbout(tree, html),
    sections,
  };
}

export async function extractProfile(
  slug: string,
  fetcher: LinkedInFetcher,
  config: Config,
  log: Logger,
): Promise<ExtractionResult> {
  const sources: string[] = [];
  const warnings: string[] = [];

  const page = await fetchProfilePage(fetcher, slug);
  sources.push(page.url);

  if (page.isEmpty) {
    // The page loaded and passed the auth check but carried no payload — a shape
    // we do not recognise rather than a known failure mode.
    throw new AppError(
      'UPSTREAM_ERROR',
      'Profile page contained no decodable payload.',
      { details: { bytes: page.html.length } },
    );
  }
  if (page.malformedRows > 0) {
    warnings.push(`${page.malformedRows} flight rows could not be parsed`);
  }

  // Seed every section from the profile page itself. For short sections this is
  // already the complete list and no further request is needed.
  const { identity, topcard, images, about, sections } = extractFromProfileHtml(
    page.html,
    page.tree,
  );

  // Fetch details pages only where the profile page offered a "Show all" link.
  const expandable = [...sectionsWithMore(page.html)];
  log.debug({ slug, expandable, seeded: [...sections.keys()] }, 'section plan');

  const detailResults = await mapWithConcurrency(
    expandable,
    Math.max(1, config.SECTION_CONCURRENCY),
    async (key): Promise<{ key: SectionKey; page: DecodedPage } | null> => {
      try {
        return { key, page: await fetchDetailsPage(fetcher, slug, SECTION_ROUTES[key]) };
      } catch (error) {
        // One unreachable section must not sink the profile.
        log.warn({ slug, section: key, err: error }, 'details page failed');
        warnings.push(`details/${SECTION_ROUTES[key]} unavailable`);
        return null;
      }
    },
  );

  for (const result of detailResults) {
    if (!result) continue;
    sources.push(result.page.url);
    const mapped = mapSection(result.key, harvestEntities(result.page.html, result.page.tree));
    // Details pages are authoritative — they hold the complete list, where the
    // profile page holds a truncated preview.
    if (mapped.length >= (sections.get(result.key)?.length ?? 0)) {
      sections.set(result.key, mapped);
    }
  }

  // Contact info is an overlay route; its absence is normal (LinkedIn hides it
  // outside your network), so failure here is a warning, never an error.
  let contactInfo = null;
  try {
    const overlay = await fetchContactInfoPage(fetcher, slug);
    sources.push(overlay.url);
    const parsed = extractContactInfo(overlay.tree, overlay.html);
    contactInfo = isEmptyContact(parsed) ? null : parsed;
  } catch (error) {
    log.debug({ slug, err: error }, 'contact info unavailable');
    warnings.push('contact info unavailable');
  }

  const draft = {
    publicIdentifier: identity.publicIdentifier || slug,
    canonicalUrl: identity.canonicalUrl || profileUrlFor(slug),
    profileUrn: identity.profileUrn,
    memberUrn: identity.memberUrn,
    ...topcard,
    about,
    profilePicture: images.picture,
    backgroundImage: images.background,
    experience: sections.get('experience') ?? [],
    education: sections.get('education') ?? [],
    skills: sections.get('skills') ?? [],
    certifications: sections.get('certifications') ?? [],
    languages: sections.get('languages') ?? [],
    projects: sections.get('projects') ?? [],
    honors: sections.get('honors') ?? [],
    volunteer: sections.get('volunteer') ?? [],
    publications: sections.get('publications') ?? [],
    courses: sections.get('courses') ?? [],
    organizations: sections.get('organizations') ?? [],
    recommendations: [],
    contactInfo,
  };

  // Validate before returning so a mapping regression surfaces here, with the
  // offending field named, rather than as malformed JSON at the client.
  const parsed = ProfileSchema.safeParse(draft);
  if (!parsed.success) {
    log.error({ slug, issues: parsed.error.issues }, 'profile failed schema validation');
    throw new AppError('INTERNAL', 'Extracted profile did not match the response schema.', {
      details: { issues: parsed.error.issues.slice(0, 5) },
    });
  }

  return {
    profile: parsed.data,
    sources,
    missingSections: SECTION_KEYS.filter((k) => (sections.get(k)?.length ?? 0) === 0),
    warnings,
  };
}
