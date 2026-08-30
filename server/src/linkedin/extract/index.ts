/**
 * Extraction orchestrator: URL in, validated Profile out.
 *
 * One page is read, twice over. It is fetched through a browser so that
 * LinkedIn's server-driven-UI runtime loads the sections that the raw document
 * omits, and then:
 *
 *   1. The flight payload that survived hydration gives identity and the top
 *      card -- structured data, no selectors involved.
 *   2. The rendered DOM gives about, experience, education, skills and the rest,
 *      which exist nowhere else. See `renderer.ts` for why.
 *
 * Every stage is allowed to fail on its own. A section that cannot be reached is
 * named in `meta.missingSections` and the rest of the profile still returns --
 * a partial profile is far more useful than an error.
 */
import type { Logger } from 'pino';
import type { Config } from '../../config.js';
import { AppError, type ErrorCode } from '../../util/errors.js';
import {
  ProfileSchema,
  SECTION_KEYS,
  type Profile,
  type SectionKey,
} from '../../schema/profile.js';
import type { LinkedInFetcher } from '../fetcher.js';
import { profileUrlFor } from '../url.js';
import {
  fetchContactInfoPage,
  fetchProfilePage,
  fetchRenderedProfilePage,
} from '../pages/profilePage.js';
import { harvestEntities, type RawEntity } from './entities.js';
import { extractIdentity, extractProfileImages, extractTopcard } from './topcard.js';
import { extractAbout } from './about.js';
import { extractContactInfo, isEmptyContact } from './contact.js';
import { segmentProfile } from './segment.js';
import { extractRenderedAbout, extractRenderedSections } from './rendered.js';
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
  const sections = new Map<SectionKey, unknown[]>();

  // The rendered DOM first, and on a rendered page it is the only one of the two
  // that finds anything -- the flight payload has no sections in it at all.
  for (const [key, entities] of extractRenderedSections(html)) {
    const mapped = mapSection(key, entities);
    if (mapped.length > 0) sections.set(key, mapped);
  }

  // Then the flight fragments, for sections the DOM pass did not cover and for
  // the plain-fetch path, where there is no rendered DOM to read.
  const fragments = segmentProfile(html);
  for (const key of SECTION_KEYS) {
    const fragment = fragments[key];
    if (!fragment || sections.has(key)) continue;
    const mapped = mapSection(key, harvestEntities(fragment, null));
    if (mapped.length > 0) sections.set(key, mapped);
  }

  return {
    identity,
    topcard: extractTopcard(tree, html, identity),
    images: extractProfileImages(tree, html, identity),
    about: extractAbout(tree, html) ?? extractRenderedAbout(html),
    sections,
  };
}

/**
 * Render failures the plain-fetch fallback cannot do better on, so they are
 * returned as-is instead of being downgraded to a warning.
 */
const FINAL_VERDICTS = new Set<ErrorCode>([
  'SESSION_INVALID',
  'CHALLENGE_REQUIRED',
  'PROFILE_NOT_FOUND',
]);

export async function extractProfile(
  slug: string,
  fetcher: LinkedInFetcher,
  config: Config,
  log: Logger,
): Promise<ExtractionResult> {
  const sources: string[] = [];
  const warnings: string[] = [];

  // Rendered when we can. The plain fetch is kept as the fallback rather than
  // deleted: it still returns identity and the top card, which is a usable
  // profile, and it is all a deployment without Chromium can offer.
  let page;
  let renderFailure: unknown;
  if (config.RENDER_PROFILES) {
    try {
      page = await fetchRenderedProfilePage(fetcher, slug, config);
    } catch (error) {
      // A verdict about the session is final. The fallback fetch carries the
      // same cookie to the same host, so it can only fail the same way, and
      // the render's answer is the one the caller can act on.
      if (error instanceof AppError && FINAL_VERDICTS.has(error.code)) throw error;
      renderFailure = error;
      log.warn({ slug, err: error }, 'render failed, falling back to plain fetch');
      warnings.push('sections unavailable: the page could not be rendered');
    }
  }
  page ??= await fetchProfilePage(fetcher, slug);
  sources.push(page.url);
  if (page.isEmpty) {
    // The page loaded and passed the auth check but carried no payload — a shape
    // we do not recognise rather than a known failure mode.
    // When the render is what went wrong, its error is the diagnosis and the
    // empty shell is only the symptom. Reporting the symptom here sent
    // operators reading the parser over a missing browser or a dead cookie.
    if (renderFailure instanceof AppError) throw renderFailure;
    throw new AppError(
      'UPSTREAM_ERROR',
      'Profile page contained no decodable payload.',
      { details: { bytes: page.html.length }, ...(renderFailure ? { cause: renderFailure } : {}) },
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

  // A details page carries the whole section where the profile card carried
  // only its first few entries, so it wins on count. Never unconditionally: a
  // details page that rendered badly must not wipe out a good card.
  for (const [route, detailHtml] of page.details ?? []) {
    sources.push(`${page.url}details/${route}/`);
    for (const [key, entities] of extractRenderedSections(detailHtml)) {
      const mapped = mapSection(key, entities);
      if (mapped.length > (sections.get(key)?.length ?? 0)) sections.set(key, mapped);
    }
  }

  log.debug(
    {
      slug,
      rendered: config.RENDER_PROFILES,
      details: [...(page.details?.keys() ?? [])],
      seeded: [...sections].map(([k, v]) => `${k}:${v.length}`),
    },
    'section plan',
  );

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
