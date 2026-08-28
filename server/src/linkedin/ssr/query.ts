/**
 * Stage 3 of decoding: search the resolved tree.
 *
 * LinkedIn's CSS class names are content-hashed and rotate on every deploy
 * (`_31136337`, `b27930f0`, `da6065ea`), so selecting on them guarantees breakage.
 * Everything here anchors on semantic identifiers instead: `viewTrackingSpecs.viewName`,
 * `componentKey`, `$type`, and URN shapes.
 */

export type Predicate = (node: unknown) => boolean;

/** React Flight encodes elements as ["$", type, key, props]. */
export function isElement(node: unknown): node is [string, unknown, unknown, Record<string, unknown>] {
  return Array.isArray(node) && node[0] === '$' && node.length >= 4;
}

export function elementProps(node: unknown): Record<string, unknown> | undefined {
  if (!isElement(node)) return undefined;
  const props = node[3];
  return props && typeof props === 'object' ? (props as Record<string, unknown>) : undefined;
}

const MAX_WALK_DEPTH = 200;

/**
 * Depth-first walk over the resolved graph. Visited objects are tracked by
 * identity so shared subtrees are traversed once and cycles terminate.
 */
export function walk(root: unknown, visit: (node: unknown) => void): void {
  const seen = new WeakSet<object>();

  const step = (node: unknown, depth: number): void => {
    if (node == null || depth > MAX_WALK_DEPTH) return;
    if (typeof node === 'object') {
      if (seen.has(node as object)) return;
      seen.add(node as object);
    }

    visit(node);

    if (Array.isArray(node)) {
      for (const item of node) step(item, depth + 1);
      return;
    }
    if (typeof node === 'object') {
      for (const value of Object.values(node as Record<string, unknown>)) {
        step(value, depth + 1);
      }
    }
  };

  step(root, 0);
}

export function findAll(root: unknown, predicate: Predicate, limit = Infinity): unknown[] {
  const out: unknown[] = [];
  walk(root, (node) => {
    if (out.length < limit && predicate(node)) out.push(node);
  });
  return out;
}

export function findFirst(root: unknown, predicate: Predicate): unknown {
  return findAll(root, predicate, 1)[0];
}

const isRecord = (n: unknown): n is Record<string, unknown> =>
  typeof n === 'object' && n !== null && !Array.isArray(n);

/** Objects carrying every one of `keys`. The workhorse for locating SDUI payload structs. */
export function findObjectsWithKeys(
  root: unknown,
  keys: readonly string[],
  limit = Infinity,
): Record<string, unknown>[] {
  return findAll(root, (n) => isRecord(n) && keys.every((k) => k in n), limit) as Record<
    string,
    unknown
  >[];
}

/** Matches on `viewTrackingSpecs.viewName` — the most stable semantic anchor in the payload. */
export function findByViewName(root: unknown, viewName: string | RegExp): unknown[] {
  const matches = (value: unknown) =>
    typeof value === 'string' &&
    (typeof viewName === 'string' ? value === viewName : viewName.test(value));

  return findAll(root, (node) => {
    if (!isRecord(node)) return false;
    const specs = node.viewTrackingSpecs;
    if (Array.isArray(specs)) {
      return specs.some((s) => isRecord(s) && matches(s.viewName));
    }
    return matches(node.viewName);
  });
}

/** Matches `componentKey` / `componentkey`, e.g. "profileCardsExperienceOnly<vanity>". */
export function findByComponentKey(root: unknown, pattern: string | RegExp): unknown[] {
  const matches = (value: unknown) =>
    typeof value === 'string' &&
    (typeof pattern === 'string' ? value === pattern : pattern.test(value));

  return findAll(
    root,
    (node) => isRecord(node) && (matches(node.componentKey) || matches(node.componentkey)),
  );
}

/** Matches the protobuf-derived `$type` discriminator, e.g. "proto.sdui.actions.core.ReplaceComponent". */
export function findByType(root: unknown, pattern: string | RegExp): Record<string, unknown>[] {
  const matches = (value: unknown) =>
    typeof value === 'string' &&
    (typeof pattern === 'string' ? value === pattern : pattern.test(value));

  return findAll(root, (node) => isRecord(node) && matches(node.$type)) as Record<
    string,
    unknown
  >[];
}

/**
 * Collects rendered text in document order.
 *
 * Only descends into element `children` and SDUI text fields, so class names,
 * tracking ids and other attribute noise never leak into the output.
 */
export function collectText(node: unknown, limit = 4000): string[] {
  const out: string[] = [];

  const step = (n: unknown, depth: number): void => {
    if (n == null || depth > MAX_WALK_DEPTH || out.length >= limit) return;

    if (typeof n === 'string') {
      if (n !== '$' && n.trim()) out.push(n);
      return;
    }
    if (typeof n === 'number') {
      out.push(String(n));
      return;
    }

    if (Array.isArray(n)) {
      if (isElement(n)) {
        step(elementProps(n)?.children, depth + 1);
        return;
      }
      for (const item of n) step(item, depth + 1);
      return;
    }

    if (isRecord(n)) {
      if (typeof n.text === 'string' && n.text.trim()) out.push(n.text);
      if ('children' in n) step(n.children, depth + 1);
      if ('accessibilityText' in n && typeof n.accessibilityText === 'string') {
        // Skipped for output but retained as a hint that this node is textual.
      }
    }
  };

  step(node, 0);
  return out;
}

/** Convenience: collected text joined and whitespace-normalised. */
export function textOf(node: unknown, separator = ' '): string {
  return collectText(node).join(separator).replace(/\s+/g, ' ').trim();
}

export interface ImageRendition {
  width: number;
  height: number;
  url: string;
}

export interface ImageAsset {
  assetUrn: string | null;
  renditions: ImageRendition[];
  /** Largest available rendition, pre-resolved for callers that want one URL. */
  url: string | null;
}

/**
 * Extracts LinkedIn's image model:
 *   { rootUrl, imageRenditions: [{ width, height, suffixUrl }], assetUrn }
 * A stable, well-typed structure — far preferable to scraping `srcSet` attributes.
 */
export function collectImageAssets(root: unknown): ImageAsset[] {
  const payloads = findObjectsWithKeys(root, ['rootUrl', 'imageRenditions']);
  const out: ImageAsset[] = [];

  for (const payload of payloads) {
    const rootUrl = typeof payload.rootUrl === 'string' ? payload.rootUrl : '';
    const renditions = Array.isArray(payload.imageRenditions) ? payload.imageRenditions : [];
    const built: ImageRendition[] = [];

    for (const r of renditions) {
      if (!isRecord(r)) continue;
      const suffix = typeof r.suffixUrl === 'string' ? r.suffixUrl : '';
      if (!rootUrl && !suffix) continue;
      built.push({
        width: typeof r.width === 'number' ? r.width : 0,
        height: typeof r.height === 'number' ? r.height : 0,
        url: `${rootUrl}${suffix}`,
      });
    }

    if (built.length === 0) continue;
    built.sort((a, b) => a.width - b.width);
    out.push({
      assetUrn: typeof payload.assetUrn === 'string' ? payload.assetUrn : null,
      renditions: built,
      url: built[built.length - 1]?.url ?? null,
    });
  }

  return out;
}
