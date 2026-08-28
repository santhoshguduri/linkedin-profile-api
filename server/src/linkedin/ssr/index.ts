/**
 * React Server Components flight payload decoder.
 *
 * LinkedIn's profile page is server-rendered; the machine-readable payload lives
 * in `window.__como_rehydration__` rather than in the markup. Decoding it yields
 * clean JSON structures (URNs, name parts, image renditions) instead of text
 * scraped from hash-named CSS classes.
 *
 *   HTML -> chunks -> rows -> resolved tree -> extractors
 */
import { rowsFromHtml, type FlightRow } from './tokenize.js';
import { createResolver, type Resolver } from './resolve.js';

export * from './tokenize.js';
export * from './resolve.js';
export * from './query.js';

export interface DecodedFlight {
  rows: Map<string, FlightRow>;
  resolver: Resolver;
  /** Every row resolved, for exhaustive searching. */
  tree: unknown[];
  /** Row "0" — the document root, when present. */
  root: unknown;
  isEmpty: boolean;
  malformedRows: string[];
}

/**
 * Resolves every row rather than only row 0. Profile data frequently lives in
 * rows that the root reaches only through lazy `$L` references which are never
 * followed during server rendering — searching all rows avoids missing them.
 */
export function decodeFlight(html: string): DecodedFlight {
  const rows = rowsFromHtml(html);
  const resolver = createResolver(rows);

  const tree: unknown[] = [];
  const malformedRows: string[] = [];

  for (const [id, row] of rows) {
    if (row.malformed) malformedRows.push(id);
    try {
      tree.push(resolver.row(id));
    } catch {
      // A single unresolvable row must not lose the other several hundred.
      malformedRows.push(id);
    }
  }

  return {
    rows,
    resolver,
    tree,
    root: rows.has('0') ? resolver.row('0') : undefined,
    isEmpty: rows.size === 0,
    malformedRows,
  };
}
