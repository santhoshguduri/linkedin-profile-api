/**
 * Stage 2 of decoding: rewrite React Flight reference sentinels into real values.
 *
 * Every sentinel handled here was observed in a live LinkedIn profile payload.
 * The reference graph is cyclic (UI action wiring points back at its own subtree),
 * so resolution tracks in-flight rows and emits a `$circular` marker rather than
 * recursing forever.
 */
import type { FlightRow } from './tokenize.js';

export const CIRCULAR = Symbol.for('flight.circular');

export interface ClientModuleRef {
  readonly __flightModule: true;
  readonly id: string;
  readonly tag: string;
  readonly value: unknown;
}

export interface SymbolRef {
  readonly __flightSymbol: string;
}

export interface ResolveOptions {
  /** Guard against pathological nesting. The observed payload peaks near 60. */
  maxDepth?: number;
}

interface Sentinel {
  kind: 'literal' | 'value' | 'row';
  /** For `literal`/`value`. */
  value?: unknown;
  /** For `row`. */
  id?: string;
  tag?: string;
  path?: string[];
}

/**
 * Classifies a `$`-prefixed string.
 *
 * The encoding is unambiguous because row ids are lowercase hex while type tags
 * are uppercase or non-hex (`L`, `Q`, `S`, `D`, `W`, `T`, `K`, `B`, `@`, `n`, `i`).
 */
export function parseSentinel(input: string): Sentinel | null {
  if (input.length === 0 || input[0] !== '$') return null;

  // Bare "$" is the React element marker in ["$", type, key, props] — not a reference.
  if (input === '$') return null;

  // "$$foo" is an escaped literal "$foo".
  if (input[1] === '$') return { kind: 'literal', value: input.slice(1) };

  const body = input.slice(1);

  switch (body) {
    case 'undefined':
      return { kind: 'value', value: undefined };
    case 'Infinity':
      return { kind: 'value', value: Infinity };
    case '-Infinity':
      return { kind: 'value', value: -Infinity };
    case 'NaN':
      return { kind: 'value', value: NaN };
  }

  const head = body[0] as string;

  // Symbols, e.g. "$Sreact.fragment"
  if (head === 'S') return { kind: 'value', value: { __flightSymbol: body.slice(1) } };

  // BigInt, e.g. "$n86400". Emitted as a number when safe so the result stays JSON-serialisable.
  if (head === 'n' && /^\d+$/.test(body.slice(1))) {
    const digits = body.slice(1);
    const asNumber = Number(digits);
    return { kind: 'value', value: Number.isSafeInteger(asNumber) ? asNumber : digits };
  }

  // Date, e.g. "$D2026-08-28T00:00:00.000Z"
  if (head === 'D') {
    const date = new Date(body.slice(1));
    return { kind: 'value', value: Number.isNaN(date.getTime()) ? body.slice(1) : date };
  }

  // Tagged row references: $L (lazy), $Q (Map), $W (Set), $@ (Promise), and friends.
  const TAGGED = 'LQW@KTBiEP';
  let tag = '';
  let rest = body;
  if (TAGGED.includes(head) && body.length > 1) {
    tag = head;
    rest = body.slice(1);
  }

  // Plain or tagged row reference, optionally with a deep path:
  //   "$fb"                              -> row fb
  //   "$139:props:children:0:props:style" -> row 139, then walk the path
  const [id, ...path] = rest.split(':');
  if (!id || !/^[0-9a-fA-F]+$/.test(id)) return null;

  return { kind: 'row', id: id.toLowerCase(), tag, path };
}

export interface Resolver {
  /** Fully resolve a single row by id. */
  row(id: string): unknown;
  /** Resolve an arbitrary value that may contain sentinels. */
  value(input: unknown): unknown;
  /** Row ids present in the payload, in insertion order. */
  ids(): string[];
}

export function createResolver(
  rows: Map<string, FlightRow>,
  options: ResolveOptions = {},
): Resolver {
  const maxDepth = options.maxDepth ?? 512;
  const cache = new Map<string, unknown>();
  const inFlight = new Set<string>();

  function walkPath(base: unknown, path: readonly string[]): unknown {
    let current = base;
    for (const segment of path) {
      if (current == null) return undefined;
      if (Array.isArray(current)) {
        const index = Number(segment);
        current = Number.isInteger(index) ? current[index] : undefined;
      } else if (typeof current === 'object') {
        current = (current as Record<string, unknown>)[segment];
      } else {
        return undefined;
      }
    }
    return current;
  }

  function resolveRow(id: string): unknown {
    if (cache.has(id)) return cache.get(id);

    const row = rows.get(id);
    if (!row) return undefined;

    // Client module references (`2c:I["<hash>",[],"Name"]`) carry no profile data.
    if (row.tag) {
      const ref: ClientModuleRef = {
        __flightModule: true,
        id: row.id,
        tag: row.tag,
        value: row.value,
      };
      cache.set(id, ref);
      return ref;
    }

    if (inFlight.has(id)) return { [CIRCULAR]: id, $circular: id };

    inFlight.add(id);
    try {
      const resolved = resolveValue(row.value, 0);
      cache.set(id, resolved);
      return resolved;
    } finally {
      inFlight.delete(id);
    }
  }

  function resolveValue(input: unknown, depth: number): unknown {
    if (depth > maxDepth) return input;

    if (typeof input === 'string') {
      const sentinel = parseSentinel(input);
      if (!sentinel) return input;

      if (sentinel.kind === 'literal' || sentinel.kind === 'value') return sentinel.value;

      const base = resolveRow(sentinel.id as string);
      const target = sentinel.path?.length ? walkPath(base, sentinel.path) : base;

      // $Q rows are Map entry lists. Materialise them as plain objects so the
      // result stays JSON-serialisable and greppable.
      if (sentinel.tag === 'Q' && Array.isArray(target)) {
        const out: Record<string, unknown> = {};
        for (const entry of target) {
          if (Array.isArray(entry) && entry.length >= 2) {
            out[String(resolveValue(entry[0], depth + 1))] = resolveValue(entry[1], depth + 1);
          }
        }
        return out;
      }
      return target;
    }

    if (Array.isArray(input)) {
      return input.map((item) => resolveValue(item, depth + 1));
    }

    if (input && typeof input === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(input as Record<string, unknown>)) {
        out[key] = resolveValue(val, depth + 1);
      }
      return out;
    }

    return input;
  }

  return {
    row: resolveRow,
    value: (input) => resolveValue(input, 0),
    ids: () => [...rows.keys()],
  };
}
