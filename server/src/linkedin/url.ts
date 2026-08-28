import { AppError } from '../util/errors.js';

export interface ParsedProfileUrl {
  publicIdentifier: string;
  canonicalUrl: string;
}

const HOST_RE = /(^|\.)linkedin\.(com|cn)$/i;

/**
 * Public identifiers are ASCII slugs, but LinkedIn also issues non-Latin ones
 * (e.g. /in/%E5%B1%B1%E7%94%B0). Decoding happens before validation so both forms
 * normalise to the same cache key.
 */
const SLUG_RE = /^[\p{L}\p{N}\-_%.]{1,120}$/u;

/** Sub-routes that may be pasted along with the profile URL and must be trimmed. */
const TRAILING_SEGMENTS = new Set([
  'details',
  'overlay',
  'recent-activity',
  'edit',
  'opportunities',
]);

function stripSlug(raw: string): string {
  let slug = raw.trim();
  try {
    slug = decodeURIComponent(slug);
  } catch {
    /* leave percent-encoded if it isn't valid UTF-8 */
  }
  return slug.replace(/\/+$/, '');
}

/**
 * Accepts anything a user might paste: full URLs, locale subdomains
 * (in.linkedin.com), legacy /pub/ paths, deep sub-routes, tracking query strings,
 * or a bare slug.
 */
export function parseProfileUrl(input: string): ParsedProfileUrl {
  const raw = (input ?? '').trim();
  if (!raw) throw new AppError('INVALID_URL', 'A LinkedIn profile URL is required.');

  // Bare slug, e.g. "santhosh-guduri-6b1b49322"
  if (!raw.includes('/') && !raw.includes('.')) {
    const slug = stripSlug(raw);
    if (!SLUG_RE.test(slug)) {
      throw new AppError('INVALID_URL', `Not a valid LinkedIn public identifier: "${raw}"`);
    }
    return { publicIdentifier: slug, canonicalUrl: profileUrlFor(slug) };
  }

  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new AppError('INVALID_URL', `Could not parse "${raw}" as a URL.`);
  }

  if (!HOST_RE.test(url.hostname)) {
    throw new AppError(
      'INVALID_URL',
      `Expected a linkedin.com URL but got host "${url.hostname}".`,
    );
  }

  const segments = url.pathname.split('/').filter(Boolean);
  const inIndex = segments.findIndex((s) => s.toLowerCase() === 'in');
  const pubIndex = segments.findIndex((s) => s.toLowerCase() === 'pub');

  let slugRaw: string | undefined;
  if (inIndex >= 0) {
    slugRaw = segments[inIndex + 1];
  } else if (pubIndex >= 0) {
    // Legacy /pub/<name>/<a>/<b>/<c> — the name segment is the identifier.
    slugRaw = segments[pubIndex + 1];
  }

  if (!slugRaw) {
    throw new AppError(
      'INVALID_URL',
      'URL does not contain a profile path. Expected linkedin.com/in/<public-identifier>.',
    );
  }

  const slug = stripSlug(slugRaw);
  if (!slug || TRAILING_SEGMENTS.has(slug.toLowerCase()) || !SLUG_RE.test(slug)) {
    throw new AppError('INVALID_URL', `Not a valid LinkedIn public identifier: "${slugRaw}"`);
  }

  return { publicIdentifier: slug, canonicalUrl: profileUrlFor(slug) };
}

export const profileUrlFor = (slug: string) =>
  `https://www.linkedin.com/in/${encodeURIComponent(slug)}/`;

export const detailsUrlFor = (slug: string, section: string) =>
  `https://www.linkedin.com/in/${encodeURIComponent(slug)}/details/${section}/`;

export const contactInfoUrlFor = (slug: string) =>
  `https://www.linkedin.com/in/${encodeURIComponent(slug)}/overlay/contact-info/`;
