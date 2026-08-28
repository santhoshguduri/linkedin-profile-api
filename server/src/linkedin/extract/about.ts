/**
 * "About" is free text with no distinguishing container of its own — it is
 * whatever follows the "About" heading. Both anchors below key on that heading
 * rather than on any class or component name.
 */
import * as cheerio from 'cheerio';
import { cleanLines, flightTextRuns } from './entities.js';

const HEADING = /^about$/i;
/** Section headings that can follow About and therefore terminate it. */
const NEXT_HEADING =
  /^(experience|education|skills|licenses|certifications|projects|activity|featured|top skills|interests|recommendations|honou?rs|languages|volunteering|publications|courses|organizations)\b/i;

const MIN_LENGTH = 20;

function fromRuns(runs: string[]): string | null {
  const index = runs.findIndex((r) => HEADING.test(r));
  if (index === -1) return null;

  const body: string[] = [];
  for (const run of runs.slice(index + 1)) {
    if (NEXT_HEADING.test(run)) break;
    if (/^(see more|see less|show all|…see more)$/i.test(run)) continue;
    body.push(run);
  }

  const text = body.join('\n').trim();
  return text.length >= MIN_LENGTH ? text : null;
}

function fromDom(html: string): string | null {
  const $ = cheerio.load(html);
  // LinkedIn marks section starts with an empty anchor whose id names the section.
  const anchor = $('#about, [id="about"]').first();
  const section = anchor.length > 0 ? anchor.closest('section') : $();
  if (section.length === 0) return null;

  // Visible copy is duplicated for screen readers; aria-hidden holds the visible one.
  const spans = section
    .find('span[aria-hidden="true"]')
    .map((_, el) => $(el).text())
    .get();

  const text = cleanLines(spans)
    .filter((line) => !HEADING.test(line))
    .join('\n')
    .trim();

  return text.length >= MIN_LENGTH ? text : null;
}

export function extractAbout(tree: unknown, html: string): string | null {
  return fromDom(html) ?? fromRuns(cleanLines(flightTextRuns(tree)));
}
