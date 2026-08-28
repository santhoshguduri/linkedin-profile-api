/**
 * Generic entity harvesting.
 *
 * Every LinkedIn detail section — experience, education, certifications and the
 * rest — renders the same underlying card: a title line, a subtitle, a caption
 * (usually dates), optional metadata, an optional logo, and optional body text.
 * Harvesting that shape once and mapping it per section is far more durable than
 * writing eleven bespoke parsers, and it keeps working when LinkedIn reorders or
 * restyles the cards.
 *
 * Nothing here reads a CSS class: LinkedIn's class names are content-hashed and
 * rotate on every deploy.
 */
import * as cheerio from 'cheerio';
import { isElement, elementProps, walk, collectImageAssets, type ImageAsset } from '../ssr/query.js';

export interface RawEntity {
  /** Visible text runs in document order, consecutive duplicates removed. */
  lines: string[];
  image: ImageAsset | null;
  links: string[];
}

/**
 * LinkedIn duplicates visible text for screen readers, so the same string often
 * appears twice in a row. Non-adjacent repeats are kept — a company name can
 * legitimately recur within one card.
 */
function dedupeConsecutive(lines: string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    if (out[out.length - 1] !== line) out.push(line);
  }
  return out;
}

/** UI chrome that is never profile data. */
const NOISE = new Set([
  '',
  '·',
  '•',
  '-',
  '–',
  '…',
  '...',
  'see more',
  'see less',
  '…see more',
  'show all',
  'show more',
  'show less',
  'helpful',
  'loading',
]);

export function cleanLines(raw: string[]): string[] {
  const normalised = raw
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s.length > 0 && !NOISE.has(s.toLowerCase()));
  return dedupeConsecutive(normalised);
}

/** Immediate text of an element node, ignoring nested elements. */
function ownText(node: unknown): string | null {
  const props = elementProps(node);
  if (!props) return null;
  const children = props.children;
  if (typeof children === 'string') return children;
  if (typeof children === 'number') return String(children);
  if (Array.isArray(children)) {
    const parts = children.filter((c): c is string => typeof c === 'string');
    if (parts.length === children.length && parts.length > 0) return parts.join('');
  }
  return null;
}

function hrefOf(node: unknown): string | null {
  const href = elementProps(node)?.href;
  return typeof href === 'string' ? href : null;
}

/** Text runs in document order from a resolved flight subtree. */
export function flightTextRuns(root: unknown): string[] {
  const runs: string[] = [];
  const seen = new WeakSet<object>();

  const step = (node: unknown, depth: number): void => {
    if (node == null || depth > 120) return;
    if (typeof node === 'object') {
      if (seen.has(node as object)) return;
      seen.add(node as object);
    }

    if (typeof node === 'string') {
      if (node !== '$') runs.push(node);
      return;
    }

    if (Array.isArray(node)) {
      if (isElement(node)) {
        const own = ownText(node);
        if (own !== null) {
          runs.push(own);
          return;
        }
        step(elementProps(node)?.children, depth + 1);
        return;
      }
      for (const item of node) step(item, depth + 1);
      return;
    }

    if (typeof node === 'object') {
      const record = node as Record<string, unknown>;
      if (typeof record.text === 'string') runs.push(record.text);
      if ('children' in record) step(record.children, depth + 1);
    }
  };

  step(root, 0);
  return runs;
}

function linksIn(root: unknown): string[] {
  const links: string[] = [];
  walk(root, (node) => {
    const href = hrefOf(node);
    if (href && !href.startsWith('#')) links.push(href);
  });
  return [...new Set(links)];
}

function largestRendition(assets: ImageAsset[]): ImageAsset | null {
  const withRenditions = assets.filter((a) => a.renditions.length > 0);
  if (withRenditions.length === 0) return null;
  return withRenditions[0] as ImageAsset;
}

/**
 * Candidate entity containers from a decoded flight tree.
 *
 * `li` elements are the primary anchor because every detail section renders its
 * items as a list. If the payload uses a different container, SDUI component keys
 * are the fallback.
 */
export function entitiesFromFlight(tree: unknown): RawEntity[] {
  const containers: unknown[] = [];

  walk(tree, (node) => {
    if (isElement(node) && node[1] === 'li') containers.push(node);
  });

  const entities: RawEntity[] = [];
  for (const container of containers) {
    const lines = cleanLines(flightTextRuns(container));
    if (lines.length === 0) continue;
    entities.push({
      lines,
      image: largestRendition(collectImageAssets(container)),
      links: linksIn(container),
    });
  }
  return entities;
}

/**
 * DOM fallback, used when a page server-renders its cards but the flight payload
 * does not expose them as list elements.
 *
 * Leaf text nodes are collected rather than `.text()` on ancestors, which would
 * concatenate every descendant into one unusable blob.
 */
export function entitiesFromDom(html: string): RawEntity[] {
  const $ = cheerio.load(html);
  const entities: RawEntity[] = [];

  $('li').each((_, li) => {
    const $li = $(li);
    // Skip wrappers that merely contain other list items.
    if ($li.find('li').length > 0) return;

    // LinkedIn renders the visible copy inside aria-hidden spans and repeats it
    // for screen readers; preferring those spans avoids the duplication.
    const ariaSpans = $li.find('span[aria-hidden="true"]');
    let runs: string[];
    if (ariaSpans.length > 0) {
      runs = ariaSpans.map((__, el) => $(el).text()).get();
    } else {
      runs = $li
        .find('*')
        .filter((__, el) => $(el).children().length === 0)
        .map((__, el) => $(el).text())
        .get();
    }

    const lines = cleanLines(runs);
    if (lines.length === 0) return;

    const src = $li.find('img').first().attr('src') ?? null;
    entities.push({
      lines,
      image: src ? { assetUrn: null, renditions: [{ width: 0, height: 0, url: src }], url: src } : null,
      links: [...new Set($li.find('a[href]').map((__, el) => $(el).attr('href') as string).get())],
    });
  });

  return entities;
}

/**
 * Runs both strategies and returns whichever produced more usable cards.
 *
 * The two paths are independent, so a LinkedIn change that breaks one usually
 * leaves the other working.
 */
export function harvestEntities(html: string, tree: unknown): RawEntity[] {
  const fromFlight = entitiesFromFlight(tree);
  const fromDom = entitiesFromDom(html);

  const score = (entities: RawEntity[]) =>
    entities.reduce((total, e) => total + Math.min(e.lines.length, 6), 0);

  return score(fromFlight) >= score(fromDom) ? fromFlight : fromDom;
}
