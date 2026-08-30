/**
 * Top-card extraction: everything LinkedIn puts in the first HTML response.
 *
 * This is the highest-confidence part of the pipeline. The identity fields are
 * not scraped from markup at all — LinkedIn ships them as a clean JSON struct in
 * the flight payload (the invitation/messaging action payload), so first name,
 * last name, canonical URL, vanity name and both URNs come out typed.
 */
import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';
import { findObjectsWithKeys, findByViewName, collectImageAssets, type ImageAsset } from '../ssr/query.js';
import { flightTextRuns, cleanLines } from './entities.js';
import { topCardRuns } from './rendered.js';
import type { ImageRendition, Profile } from '../../schema/profile.js';

/**
 * LinkedIn encodes media type in the URL path, which is far more stable than any
 * DOM position: `profile-displayphoto-shrink_100_100`, `profile-displaybackgroundimage-shrink_`.
 */
const PHOTO_RE = /profile-displayphoto/i;
const BACKGROUND_RE = /profile-displaybackgroundimage|profile-banner/i;

const PROFILE_URN_RE = /(?:urn:li:fsd_profile:)+([A-Za-z0-9_-]+)/;

/**
 * The profile id as it survives in the rendered DOM.
 *
 * Hydration drops the `urn:li:fsd_profile:...` strings entirely, but the SDUI
 * component keys still carry the id verbatim -- `sdui.profile.card.refACoAA...Topcard`.
 * Ids are a fixed 39 characters, which is why the length is pinned here: the
 * card name is concatenated straight onto the end with no separator, so a greedy
 * match would swallow "Topcard" along with it.
 */
const COMPONENT_KEY_URN_RE = /sdui\.profile\.card\.ref(ACo[A-Za-z0-9_-]{36})/;

/**
 * Strips LinkedIn's decorations from the document title.
 *
 * Two of them, and both have bitten: the page carries an unread-notification
 * count as a "(5) " prefix, and the previous suffix pattern was written
 * `/\s\*\|\s*LinkedIn$/`, where `\*` matches a literal asterisk rather than
 * repeating the whitespace -- so it never matched and the full name came out as
 * "(5) Bill Gates | LinkedIn", which in turn stopped the headline being found.
 */
function nameFromTitle(title: string): string | null {
  return (
    title
      .replace(/^\(\d+\)\s*/, '')
      .replace(/\s*\|\s*LinkedIn\s*$/i, '')
      .trim() || null
  );
}

export interface Identity {
  firstName: string | null;
  lastName: string | null;
  publicIdentifier: string | null;
  canonicalUrl: string | null;
  profileUrn: string | null;
  memberUrn: string | null;
  /** Base64 protobuf; used only to disambiguate which photo belongs to this profile. */
  pictureHint: string | null;
}

/**
 * The invitation payload carries the subject's identity as one struct. Several
 * key spellings are tried because the payload differs between connect, withdraw
 * and message actions.
 */
export function extractIdentity(tree: unknown, html: string): Identity {
  const candidates = [
    ...findObjectsWithKeys(tree, ['inviteeVanityName']),
    ...findObjectsWithKeys(tree, ['firstName', 'lastName', 'profileCanonicalUrl']),
    ...findObjectsWithKeys(tree, ['firstName', 'lastName', 'vanityName']),
  ];

  const pick = (keys: string[]): string | null => {
    for (const candidate of candidates) {
      for (const key of keys) {
        const value = candidate[key];
        if (typeof value === 'string' && value.trim()) return value.trim();
      }
    }
    return null;
  };

  // URNs come doubled in some payloads: "urn:li:fsd_profile:urn:li:fsd_profile:ACo...".
  // The `+` on the prefix group is what handles that -- without it the id class
  // stops at the second colon and captures the literal string "urn".
  const rawProfileUrn = pick(['profileUrn', 'vieweeProfileUrn']);
  const profileId =
    PROFILE_URN_RE.exec(rawProfileUrn ?? '')?.[1] ??
    PROFILE_URN_RE.exec(html)?.[1] ??
    COMPONENT_KEY_URN_RE.exec(html)?.[1] ??
    null;

  let memberId: string | null = null;
  for (const candidate of candidates) {
    const invitee = candidate.inviteeUrn;
    if (invitee && typeof invitee === 'object' && 'memberId' in invitee) {
      const value = (invitee as Record<string, unknown>).memberId;
      if (typeof value === 'string' || typeof value === 'number') memberId = String(value);
    }
  }
  memberId ??= /urn:li:member:(\d+)/.exec(html)?.[1] ?? null;

  return {
    firstName: pick(['firstName']),
    lastName: pick(['lastName']),
    publicIdentifier: pick(['inviteeVanityName', 'vanityName']),
    canonicalUrl: pick(['profileCanonicalUrl']),
    profileUrn: profileId ? `urn:li:fsd_profile:${profileId}` : null,
    memberUrn: memberId ? `urn:li:member:${memberId}` : null,
    pictureHint: pick(['profilePictureRenderPayload']),
  };
}

/**
 * A profile page also contains the viewer's own avatar (nav) and several
 * browsemap faces, so the right photo has to be identified rather than guessed.
 *
 * Three anchors, most reliable first:
 *  1. the asset id embedded in the subject's own `profilePictureRenderPayload`
 *  2. the LCP `<link rel="preload" as="image">` the server emits for the top card
 *  3. the first profile-photo asset in document order
 */

/** Parses a srcset into renditions, smallest first. Widths are the only size hint srcset gives. */
function renditionsFromSrcset(srcset: string): ImageRendition[] {
  return srcset
    .split(',')
    .map((part) => part.trim().split(/\s+/))
    .flatMap(([url, descriptor]) => {
      if (!url) return [];
      const width = Number(/^(\d+)w$/.exec(descriptor ?? '')?.[1] ?? 0);
      return [{ width, height: width, url }];
    })
    .sort((a, b) => a.width - b.width);
}

const assetFromUrls = (urls: ImageRendition[]): ImageAsset | null =>
  urls.length === 0
    ? null
    : { assetUrn: null, renditions: urls, url: urls[urls.length - 1]?.url ?? null };

/**
 * Image fallback for pages whose media never reaches the flight payload.
 *
 * Disambiguation matters here: the document also holds the *viewer's* avatar in
 * the nav and other members' faces in the "people also viewed" rail. The subject's
 * photo is identified by the LCP preload link the server emits for it, falling
 * back to an image inside the top card — never by "first photo on the page".
 */
function imagesFromDom(html: string): { picture: ImageAsset | null; background: ImageAsset | null } {
  const $ = cheerio.load(html);

  /**
   * Pulls every usable image URL out of an existing selection.
   *
   * Takes nodes rather than a selector string on purpose. This used to build a
   * selector by mapping the card's images back to `#<their id>` -- which broke
   * the moment an <img> had no id, because the join produced a bare `#` and the
   * CSS parser threw. LinkedIn does not give every avatar an id, so that was a
   * crash waiting for the right profile. The elements are already in hand; there
   * is no reason to round-trip them through a selector at all.
   */
  const collectFrom = (nodes: cheerio.Cheerio<AnyNode>): ImageRendition[] => {
    const out: ImageRendition[] = [];
    nodes.each((_, el) => {
      const node = $(el);
      const srcset = node.attr('imagesrcset') ?? node.attr('srcset');
      if (srcset) out.push(...renditionsFromSrcset(srcset));
      const src = node.attr('href') ?? node.attr('src');
      if (src && /^https?:/.test(src)) out.push({ width: 0, height: 0, url: src });
    });
    return out;
  };

  const collect = (selector: string): ImageRendition[] => collectFrom($(selector));

  const preload = collect('link[rel="preload"][as="image"]').filter((r) => PHOTO_RE.test(r.url));

  const link = $('a[href*="/overlay/contact-info"]').first();
  const card = link.length > 0 ? link.closest('section') : $('main section').first();
  const cardPhotos = card.length > 0 ? collectFrom(card.find('img')) : [];

  const inCard: ImageRendition[] = [];
  card.find('img').each((_, el) => {
    const node = $(el);
    const srcset = node.attr('srcset');
    if (srcset) inCard.push(...renditionsFromSrcset(srcset).filter((r) => PHOTO_RE.test(r.url)));
    const src = node.attr('src');
    if (src && PHOTO_RE.test(src)) inCard.push({ width: 0, height: 0, url: src });
  });

  const backgrounds = collect('img, link[rel="preload"][as="image"]').filter((r) =>
    BACKGROUND_RE.test(r.url),
  );

  return {
    picture: assetFromUrls(preload.length > 0 ? preload : inCard.length > 0 ? inCard : cardPhotos),
    background: assetFromUrls(backgrounds),
  };
}

export function extractProfileImages(
  tree: unknown,
  html: string,
  identity: Identity,
): { picture: ImageAsset | null; background: ImageAsset | null } {
  const assets = collectImageAssets(tree);
  const photos = assets.filter((a) => a.renditions.some((r) => PHOTO_RE.test(r.url)));
  const backgrounds = assets.filter((a) => a.renditions.some((r) => BACKGROUND_RE.test(r.url)));

  let picture: ImageAsset | null = null;

  if (identity.pictureHint) {
    try {
      const decoded = Buffer.from(identity.pictureHint, 'base64').toString('latin1');
      const assetId = /([A-Z0-9]{4}03AQ[A-Za-z0-9_-]{10,})/.exec(decoded)?.[1];
      if (assetId) {
        picture = photos.find((a) => a.renditions.some((r) => r.url.includes(assetId))) ?? null;
      }
    } catch {
      /* hint is best-effort */
    }
  }

  if (!picture) {
    const preload = cheerio.load(html)('link[rel="preload"][as="image"]').first();
    const srcset = preload.attr('imagesrcset') ?? preload.attr('imageSrcSet');
    const assetId = srcset ? /image\/v2\/([A-Za-z0-9_-]+)\//.exec(srcset)?.[1] : undefined;
    if (assetId) {
      picture = photos.find((a) => a.renditions.some((r) => r.url.includes(assetId))) ?? null;
    }
  }

  picture ??= photos[0] ?? null;

  let background = backgrounds[0] ?? null;

  if (!picture || !background) {
    const dom = imagesFromDom(html);
    picture ??= dom.picture;
    background ??= dom.background;
  }

  return { picture, background };
}

/** LinkedIn renders an absent headline as a literal "--". */
const normaliseHeadline = (value: string | null): string | null =>
  !value || /^-{1,2}$/.test(value.trim()) ? null : value.trim();

const COUNTRY_RE = /,\s*([^,]+)$/;


/** Display fields readable from one stream of text runs. */
function readCard(runs: string[], fullName: string | null) {
  const nameIndex = fullName
    ? runs.findIndex((r) => r === fullName || r.startsWith(fullName))
    : -1;

  const headline = nameIndex >= 0 ? normaliseHeadline(runs[nameIndex + 1] ?? null) : null;

  const contactIndex = runs.findIndex((r) => /^contact info$/i.test(r));
  let locationText: string | null = null;
  if (contactIndex > 0) {
    const candidate = runs[contactIndex - 1];
    // Guard against picking up the connection count that sits beside the link.
    if (candidate && !/followers?|connections?/i.test(candidate)) locationText = candidate;
  }

  const joined = runs.join(' | ');
  const followerMatch = /([\d,]+)\s+followers?/i.exec(joined);
  const connectionMatch = /([\d,+]+)\s+connections?/i.exec(joined);
  const distanceMatch = /\b(1st|2nd|3rd)\b/i.exec(joined);

  return {
    headline,
    locationText,
    followerCount: followerMatch?.[1] ? Number(followerMatch[1].replace(/,/g, '')) : null,
    connectionCount: connectionMatch?.[1] ?? null,
    networkDistance: distanceMatch?.[1]?.toLowerCase() ?? null,
    isPremium: /premium/i.test(joined),
    isOpenToWork: /open to work|#opentowork/i.test(joined),
  };
}

/**
 * Reads the display fields out of the top-card subtree.
 *
 * Positional within the card rather than selector-based: the name is located
 * first (it is known independently from the page title and the identity struct),
 * then the headline is the next run and the location is the run immediately
 * before the "Contact info" link.
 */
export function extractTopcard(tree: unknown, html: string, identity: Identity) {
  const $ = cheerio.load(html);
  const fromTitle = nameFromTitle($('title').first().text());

  const composed =
    [identity.firstName, identity.lastName].filter(Boolean).join(' ').trim() || null;
  const fullName = composed ?? fromTitle;

  const cardNodes = findByViewName(tree, /profile-top-card/);
  const flight = readCard(cleanLines(flightTextRuns(cardNodes.length > 0 ? cardNodes : tree)), fullName);
  const dom = readCard(topCardRuns(html), fullName);

  // Field by field rather than source by source: the two anchors fail on
  // different fields, so preferring one wholesale would discard good data.
  const pick = <K extends keyof typeof flight>(key: K) => flight[key] || dom[key];

  const locationText = pick('locationText');

  return {
    fullName,
    firstName: identity.firstName ?? fullName?.split(' ')[0] ?? null,
    lastName: identity.lastName ?? (fullName?.split(' ').slice(1).join(' ') || null),
    headline: pick('headline'),
    location: locationText
      ? { text: locationText, country: COUNTRY_RE.exec(locationText)?.[1]?.trim() ?? null }
      : null,
    followerCount: pick('followerCount'),
    connectionCount: pick('connectionCount'),
    networkDistance: pick('networkDistance'),
    isPremium: flight.isPremium || dom.isPremium || $('[aria-label*="Premium" i]').length > 0,
    isOpenToWork: flight.isOpenToWork || dom.isOpenToWork,
  } satisfies Partial<Profile> & Record<string, unknown>;
}
