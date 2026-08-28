/**
 * Stage 1 of decoding: pull the React Server Components flight stream out of the
 * profile HTML and split it into addressable rows.
 *
 * LinkedIn embeds the stream as a JSON array of string chunks:
 *
 *   <script id="rehydrate-data">window.__como_rehydration__ = ["1:I[...]\n2:...", "0:[...]", ...]</script>
 *
 * Chunk boundaries are arbitrary and routinely fall mid-token — one observed chunk
 * ends `"$type":"proto.sdui.a` and the next opens `ctions.core.ShowToast"`. Chunks
 * must therefore be concatenated before anything is parsed.
 */

export interface FlightRow {
  /** Lowercase hex row id, e.g. "0", "2c", "139". */
  id: string;
  /** Single uppercase tag, e.g. "I" for a client module reference. Empty for plain JSON. */
  tag: string;
  /** Parsed JSON payload, or the raw string when the row is not valid JSON. */
  value: unknown;
  /** True when the payload could not be parsed as JSON. */
  malformed: boolean;
}

const REHYDRATION_VAR = '__como_rehydration__';

const CH_QUOTE = 0x22;
const CH_BACKSLASH = 0x5c;
const CH_OPEN = 0x5b;
const CH_CLOSE = 0x5d;

/**
 * Scans forward from an opening bracket to its match, tracking JSON string state
 * so brackets inside string literals do not affect depth. Regex cannot do this —
 * the payload is ~1 MB with heavily nested arrays. Character codes are compared
 * directly because this runs over every byte of the document.
 */
function matchBracket(source: string, openIndex: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = openIndex; i < source.length; i++) {
    const code = source.charCodeAt(i);

    if (inString) {
      if (escaped) escaped = false;
      else if (code === CH_BACKSLASH) escaped = true;
      else if (code === CH_QUOTE) inString = false;
      continue;
    }

    if (code === CH_QUOTE) inString = true;
    else if (code === CH_OPEN) depth++;
    else if (code === CH_CLOSE) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Returns the raw chunk array, or an empty array when the page carries no
 * rehydration payload (logged-out authwall, checkpoint, or 404 shells).
 */
export function extractRehydrationChunks(html: string): string[] {
  const varIndex = html.indexOf(REHYDRATION_VAR);
  if (varIndex === -1) return [];

  const openIndex = html.indexOf('[', varIndex);
  if (openIndex === -1) return [];

  const closeIndex = matchBracket(html, openIndex);
  if (closeIndex === -1) return [];

  try {
    const parsed: unknown = JSON.parse(html.slice(openIndex, closeIndex + 1));
    return Array.isArray(parsed) ? parsed.filter((c): c is string => typeof c === 'string') : [];
  } catch {
    return [];
  }
}

/** Row header: hex id, colon, optional uppercase tag. JSON values never begin with A-Z. */
const ROW_HEAD_RE = /^([0-9a-fA-F]+):([A-Z]?)/;

/**
 * Splits the concatenated stream into rows.
 *
 * Rows are newline-delimited and raw newlines cannot appear inside JSON strings,
 * so line splitting is sound. Parsing is still incremental — if a line does not
 * parse, following lines are appended until it does. A row that never parses is
 * kept with `malformed: true` rather than aborting the payload, so one bad row
 * costs one row instead of the whole profile.
 */
export function tokenizeFlight(stream: string): Map<string, FlightRow> {
  const rows = new Map<string, FlightRow>();
  const lines = stream.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const head = ROW_HEAD_RE.exec(line);
    if (!head) continue;

    const id = (head[1] as string).toLowerCase();
    const tag = head[2] as string;
    let body = line.slice(head[0].length);

    let value: unknown;
    let malformed = false;
    for (;;) {
      try {
        value = JSON.parse(body);
        break;
      } catch {
        const next = lines[i + 1];
        // Stop absorbing at the next row header, otherwise a malformed row would
        // swallow the rest of the stream.
        if (next === undefined || ROW_HEAD_RE.test(next)) {
          value = body;
          malformed = true;
          break;
        }
        body += `\n${next}`;
        i++;
      }
    }

    rows.set(id, { id, tag, value, malformed });
  }

  return rows;
}

/** Convenience: HTML in, rows out. */
export function rowsFromHtml(html: string): Map<string, FlightRow> {
  const chunks = extractRehydrationChunks(html);
  if (chunks.length === 0) return new Map();
  return tokenizeFlight(chunks.join(''));
}
