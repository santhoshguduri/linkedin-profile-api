/**
 * Fetches and decodes the pages we read: the profile itself, plain or rendered,
 * and the contact-info overlay.
 *
 * Each returns the decoded flight tree alongside the raw HTML because the two
 * extraction strategies need different inputs and we only want one fetch.
 */
import type { Config } from '../../config.js';
import type { LinkedInFetcher } from '../fetcher.js';
import { truncatedSections } from '../extract/rendered.js';
import { renderProfile } from '../renderer.js';
import { decodeFlight } from '../ssr/index.js';
import { contactInfoUrlFor, profileUrlFor } from '../url.js';

export interface DecodedPage {
  url: string;
  html: string;
  /** Rendered `/details/<route>/` pages, by route. Empty unless rendered. */
  details?: Map<string, string>;
  tree: unknown;
  /** True when the page carried no rehydration payload we could decode. */
  isEmpty: boolean;
  malformedRows: number;
}

/**
 * Saves the raw HTML of every page fetched, when CAPTURE_DIR is set.
 *
 * Parser work needs the real markup. Without a capture, diagnosing a missing
 * section means guessing at LinkedIn's DOM and spending a live request per
 * guess -- which is both slow and the fastest way to get throttled. One captured
 * request feeds `npm run decode` indefinitely, offline.
 *
 * Off by default and gitignored when on: these pages are fetched with a real
 * session and the markup carries the CSRF token.
 */
async function capture(url: string, html: string): Promise<void> {
  const dir = process.env.CAPTURE_DIR?.trim();
  if (!dir) return;
  try {
    const { mkdir, writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    await mkdir(dir, { recursive: true });
    const name = (new URL(url).pathname.replace(/^\/|\/$/g, '') || 'index')
      .replace(/[^a-z0-9._-]+/gi, '_')
      .slice(0, 120);
    await writeFile(join(dir, `${name}.raw.html`), html, 'utf8');
  } catch {
    /* capturing must never break a lookup */
  }
}

async function load(fetcher: LinkedInFetcher, url: string): Promise<DecodedPage> {
  const result = await fetcher.fetchAuthenticatedHtml(url);
  await capture(result.url, result.body);
  const decoded = decodeFlight(result.body);
  return {
    url: result.url,
    html: result.body,
    tree: decoded.tree,
    isEmpty: decoded.isEmpty,
    malformedRows: decoded.malformedRows.length,
  };
}

export const fetchProfilePage = (fetcher: LinkedInFetcher, slug: string): Promise<DecodedPage> =>
  load(fetcher, profileUrlFor(slug));

/**
 * The profile as a browser sees it, once the lazy sections have loaded.
 *
 * Costs a Chromium page and several seconds, and is the only way to obtain the
 * sections at all -- see `renderer.ts` for why the plain fetch cannot. The
 * flight payload is still decoded from the rendered markup: the original
 * server-rendered rows survive hydration, so the top card keeps its structured
 * source while the sections come from the DOM.
 */
export async function fetchRenderedProfilePage(
  fetcher: LinkedInFetcher,
  slug: string,
  config: Config,
): Promise<DecodedPage> {
  const url = profileUrlFor(slug);
  const { html, details } = await renderProfile(
    url,
    {
      credentials: fetcher.credentials,
      headless: config.BROWSER_HEADLESS,
      timeoutMs: config.RENDER_TIMEOUT_MS,
      proxyUrl: config.PROXY_URL,
    },
    truncatedSections,
  );
  await capture(`${url}rendered`, html);
  for (const [route, page] of details) await capture(`${url}details-${route}`, page);
  const decoded = decodeFlight(html);
  return {
    url,
    html,
    details,
    tree: decoded.tree,
    // A rendered page is never empty in the sense that matters: the sections are
    // in the DOM whether or not a flight payload survived hydration.
    isEmpty: false,
    malformedRows: decoded.malformedRows.length,
  };
}

export const fetchContactInfoPage = (
  fetcher: LinkedInFetcher,
  slug: string,
): Promise<DecodedPage> => load(fetcher, contactInfoUrlFor(slug));
