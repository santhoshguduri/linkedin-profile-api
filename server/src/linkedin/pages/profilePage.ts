/**
 * Fetches and decodes the three page types we read: the profile itself, a
 * /details/<section>/ list, and the contact-info overlay.
 *
 * Each returns the decoded flight tree alongside the raw HTML because the two
 * extraction strategies need different inputs and we only want one fetch.
 */
import type { LinkedInFetcher } from '../fetcher.js';
import { decodeFlight } from '../ssr/index.js';
import { contactInfoUrlFor, detailsUrlFor, profileUrlFor } from '../url.js';

export interface DecodedPage {
  url: string;
  html: string;
  tree: unknown;
  /** True when the page carried no rehydration payload we could decode. */
  isEmpty: boolean;
  malformedRows: number;
}

async function load(fetcher: LinkedInFetcher, url: string): Promise<DecodedPage> {
  const result = await fetcher.fetchAuthenticatedHtml(url);
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

export const fetchDetailsPage = (
  fetcher: LinkedInFetcher,
  slug: string,
  route: string,
): Promise<DecodedPage> => load(fetcher, detailsUrlFor(slug, route));

export const fetchContactInfoPage = (
  fetcher: LinkedInFetcher,
  slug: string,
): Promise<DecodedPage> => load(fetcher, contactInfoUrlFor(slug));
