/**
 * Offline decoder: `npm run decode -- <file.html> [--rows] [--runs]`
 *
 * Runs the real extraction pipeline against a saved capture. This is the
 * debugging loop for parser work — an extraction bug becomes reproducible from a
 * file instead of costing a live LinkedIn request (and the throttling risk that
 * carries) on every iteration.
 */
import { readFileSync } from 'node:fs';
import { decodeFlight } from '../src/linkedin/ssr/index.js';
import { detectAuthState } from '../src/linkedin/session.js';
import { extractFromProfileHtml } from '../src/linkedin/extract/index.js';
import { extractContactInfo } from '../src/linkedin/extract/contact.js';
import { segmentProfile, sectionsWithMore } from '../src/linkedin/extract/segment.js';
import { cleanLines, flightTextRuns } from '../src/linkedin/extract/entities.js';

const [file, ...flags] = process.argv.slice(2);
if (!file) {
  console.error('usage: npm run decode -- <file.html> [--rows] [--runs] [--contact]');
  process.exit(1);
}

const html = readFileSync(file, 'utf8');
const authState = detectAuthState(200, html);
const decoded = decodeFlight(html);

console.log('=== page ===');
console.table({
  bytes: html.length,
  authState,
  flightRows: decoded.rows.size,
  malformedRows: decoded.malformedRows.length,
  hasPayload: !decoded.isEmpty,
});

if (authState !== 'authenticated') {
  console.log(`\nNot an authenticated page (${authState}); nothing to extract.`);
  process.exit(0);
}

if (flags.includes('--rows')) {
  console.log('\n=== rows ===');
  for (const [id, row] of decoded.rows) {
    const preview = JSON.stringify(row.value).slice(0, 110);
    console.log(`${id.padStart(4)}${row.tag ? `:${row.tag}` : '  '} ${preview}`);
  }
}

if (flags.includes('--runs')) {
  console.log('\n=== text runs ===');
  for (const run of cleanLines(flightTextRuns(decoded.tree)).slice(0, 200)) {
    console.log(`  ${run}`);
  }
}

if (flags.includes('--contact')) {
  console.log('\n=== contact info ===');
  console.dir(extractContactInfo(decoded.tree, html), { depth: 4 });
  process.exit(0);
}

console.log('\n=== segmentation ===');
console.table({
  fragments: Object.keys(segmentProfile(html)).join(', ') || '(none)',
  expandable: [...sectionsWithMore(html)].join(', ') || '(none)',
});

const result = extractFromProfileHtml(html, decoded.tree);

console.log('\n=== identity ===');
console.dir(result.identity, { depth: 3 });

console.log('\n=== topcard ===');
console.dir({ ...result.topcard, about: result.about?.slice(0, 160) }, { depth: 3 });

console.log('\n=== images ===');
console.table({
  picture: result.images.picture?.url ?? '(none)',
  background: result.images.background?.url ?? '(none)',
});

console.log('\n=== sections ===');
for (const [key, items] of result.sections) {
  console.log(`\n-- ${key} (${items.length}) --`);
  console.dir(items.slice(0, 3), { depth: 4 });
}
