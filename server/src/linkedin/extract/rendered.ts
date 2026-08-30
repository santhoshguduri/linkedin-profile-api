/**
 * Section extraction from the hydrated DOM.
 *
 * This is the only source for experience, education, skills and the rest. The
 * document LinkedIn serves over HTTP carries none of them -- see `renderer.ts`
 * -- so everything here reads markup that exists only after the page's own
 * runtime has fetched its cards.
 *
 * Nothing is selected by class name. LinkedIn ships hashed CSS modules, so the
 * top card is `class="_02484ad3 _1f667e81 f28af954 ..."` and those hashes change
 * on every release. What is stable is `componentkey`, the identifier the SDUI
 * runtime uses to address a component, and the section headings themselves.
 * Both are load-bearing for LinkedIn, which is what makes them worth binding to.
 */
import * as cheerio from 'cheerio';
import type { AnyNode, Element } from 'domhandler';
import { SECTION_ROUTES, type ImageAsset, type SectionKey } from '../../schema/profile.js';
import { cleanLines, type RawEntity } from './entities.js';

type Api = cheerio.CheerioAPI;
type Node = cheerio.Cheerio<AnyNode>;

/**
 * Heading text to section key.
 *
 * Keyed on the heading because it is the one label LinkedIn cannot obfuscate:
 * it is what the reader sees. Spelling variants are listed rather than matched
 * loosely so that a new section never lands in the wrong bucket by accident.
 */
const HEADINGS = new Map<string, SectionKey>([
  ['experience', 'experience'],
  ['education', 'education'],
  ['skills', 'skills'],
  ['licenses & certifications', 'certifications'],
  ['licenses and certifications', 'certifications'],
  ['certifications', 'certifications'],
  ['languages', 'languages'],
  ['projects', 'projects'],
  ['honors & awards', 'honors'],
  ['honors and awards', 'honors'],
  ['volunteering', 'volunteer'],
  ['volunteer experience', 'volunteer'],
  ['publications', 'publications'],
  ['courses', 'courses'],
  ['organizations', 'organizations'],
]);

/** Controls and separators that are markup, not content. */
const NOT_CONTENT =
  /^(?:show all.*|see more|see less|·|•|\||-|–|—|,)$/i;

const normalise = (value: string): string => value.replace(/\s+/g, ' ').trim();

/**
 * A heading reduced to its lookup key.
 *
 * LinkedIn appends a count to some headings once the section is populated --
 * "Skills (40)", but plain "Experience" -- so an exact match silently drops
 * whichever sections happen to be large enough to be worth counting.
 */
const headingKey = (text: string): string =>
  normalise(text)
    .replace(/\s*\(\d[\d,]*\)\s*$/, '')
    .toLowerCase();

const absolute = (href: string): string =>
  href.startsWith('http') ? href : `https://www.linkedin.com${href}`;

/** Visible text of every leaf element, in document order. */
function leafRuns($: Api, node: Node): string[] {
  const runs: string[] = [];
  node.find('*').each((_, el) => {
    const child = $(el);
    if (child.children().length > 0) return;
    const text = normalise(child.text());
    if (text) runs.push(text);
  });
  return cleanLines(runs).filter((line) => !NOT_CONTENT.test(line));
}

/**
 * The entry containers within a section.
 *
 * Two different shapes are in play and both have to work: experience entries are
 * `<div componentkey="entity-collection-item-770fafcc">`, while education
 * entries are `<div componentkey="e9266471-cafb-...">` separated by `<hr>`. What
 * they share is being keyed, carrying text, and not containing the section
 * heading -- so that, plus dropping any candidate nested inside another, is the
 * rule rather than either specific key format.
 */
function entriesIn($: Api, section: Node): Node[] {
  const candidates: Element[] = [];
  section.find('[componentkey]').each((_, el) => {
    const node = $(el);
    if (node.find('h2').length > 0) return;
    if (!normalise(node.text())) return;
    candidates.push(el as Element);
  });

  // Outermost only. An experience entry contains a keyed `<a>` of its own, and
  // counting that as a sibling entry would double every row.
  return candidates
    .filter((el) => !candidates.some((other) => other !== el && $(other).find(el).length > 0))
    .map((el) => $(el));
}

/** First image in an entry — a company or school logo. */
function logoOf($: Api, node: Node): ImageAsset | null {
  const src = node.find('img[src]').first().attr('src');
  if (!src) return null;
  return { assetUrn: null, renditions: [{ width: 0, height: 0, url: src }], url: src };
}

/** "2 yrs 2 mos" on its own -- tenure, not an employment type. */
const DURATION_ONLY = /^\d+\s*(?:yrs?|years?|mos?|months?)(?:\s+\d+\s*(?:mos?|months?))?$/i;

const DOTTED = /\s*[·•]\s*/;

/**
 * Several roles at one employer are one entry in the DOM, not several.
 *
 * LinkedIn renders a promotion history as a company header -- name, employment
 * type, total tenure, location -- followed by a `<ul>` with one `<li>` per role.
 * The roles carry no `componentkey` of their own, so without this the entire
 * group collapses into a single job whose title is the company name: three years
 * at Reflektive across two titles came back as one job called "Reflektive".
 *
 * Each role is re-emitted in the shape an ungrouped entry already has, with the
 * company's details folded back in, so the mapper needs to know nothing about
 * grouping.
 */
function expandRoleGroup($: Api, node: Node): RawEntity[] | null {
  const list = node.children('ul').first();
  const roles = list.children('li').toArray();
  if (list.length === 0 || roles.length === 0) return null;

  const [company, ...rest] = leafRuns($, node.children('div').first());
  if (!company) return null;

  // "Full-time · 2 yrs 2 mos" -> the employment type, dropping the tenure, which
  // belongs to the group rather than to any one role.
  const employmentType = (rest[0] ?? '')
    .split(DOTTED)
    .map((part) => part.trim())
    .find((part) => part && !DURATION_ONLY.test(part));

  const companyLine = employmentType ? `${company} · ${employmentType}` : company;
  const location = rest.length > 1 ? rest[rest.length - 1] : undefined;
  const logo = logoOf($, node);

  return roles
    .map((el) => {
      const role = $(el);
      const runs = leafRuns($, role);
      const [title, ...tail] = runs;
      if (!title) return null;

      const entity = toEntity($, role);
      return {
        ...entity,
        lines: [
          title,
          companyLine,
          ...(tail[0] ? [tail[0]] : []),
          ...(location ? [location] : []),
          ...tail.slice(1),
        ],
        image: entity.image ?? logo,
      };
    })
    .filter((entity): entity is RawEntity => entity !== null);
}

function toEntity($: Api, node: Node): RawEntity {
  const links = node
    .find('a[href]')
    .map((_, a) => $(a).attr('href') ?? '')
    .get()
    .filter(Boolean)
    .map(absolute);

  return {
    lines: leafRuns($, node),
    image: logoOf($, node),
    links: [...new Set(links)],
  };
}

/**
 * The `<section>` a heading belongs to.
 *
 * Falls back to walking up until the subtree holds more than the heading text,
 * because not every card is wrapped in a `<section>` element -- the About card,
 * for one, is nested divs all the way up.
 */
function sectionFor(heading: Node): Node {
  const section = heading.closest('section');
  if (section.length > 0) return section;

  let node = heading.parent();
  const headingLength = normalise(heading.text()).length;
  for (let depth = 0; depth < 6 && node.length > 0; depth += 1) {
    if (normalise(node.text()).length > headingLength) return node;
    node = node.parent();
  }
  return heading.parent();
}

/** Every profile section present in the rendered page, as raw entities. */
export function extractRenderedSections(html: string): Map<SectionKey, RawEntity[]> {
  const $ = cheerio.load(html);
  $('script, style, noscript').remove();

  const found = new Map<SectionKey, RawEntity[]>();
  $('h2').each((_, el) => {
    const heading = $(el);
    const key = HEADINGS.get(headingKey(heading.text()));
    // First heading wins. LinkedIn repeats section names further down the page
    // in "people also viewed" cards, which are other people's sections.
    if (!key || found.has(key)) return;

    const entities = entriesIn($, sectionFor(heading))
      .flatMap((node) => expandRoleGroup($, node) ?? [toEntity($, node)])
      .filter((entity) => entity.lines.length > 0);

    if (entities.length > 0) found.set(key, entities);
  });

  return found;
}

/** Route segment back to the section it belongs to. */
const ROUTE_TO_SECTION = new Map<string, SectionKey>(
  Object.entries(SECTION_ROUTES).map(([key, route]) => [route, key as SectionKey]),
);

/**
 * The sections whose card is only showing the first few entries.
 *
 * A populated card ends in a "Show all 40 skills" link to
 * `/in/<slug>/details/skills/`, and the presence of that link is the page's own
 * statement that the card is incomplete. Routes that are not profile sections --
 * `details/recommendations`, `details/add-connected-account` -- fall out here
 * because they have no entry in `SECTION_ROUTES`.
 */
export function truncatedSections(html: string): Set<string> {
  const $ = cheerio.load(html);
  const routes = new Set<string>();
  $('a[href*="/details/"]').each((_, el) => {
    const route = /\/details\/([a-z-]+)/.exec($(el).attr('href') ?? '')?.[1];
    if (route && ROUTE_TO_SECTION.has(route)) routes.add(route);
  });
  return routes;
}

/**
 * The About text.
 *
 * Read as the longest run in the About card rather than the first: the card also
 * contains a "see more" toggle and, on some profiles, a translation control.
 */
export function extractRenderedAbout(html: string): string | null {
  const $ = cheerio.load(html);
  $('script, style, noscript').remove();

  const heading = $('h2')
    .filter((_, el) => normalise($(el).text()).toLowerCase() === 'about')
    .first();
  if (heading.length === 0) return null;

  const runs = leafRuns($, sectionFor(heading)).filter(
    (line) => line.toLowerCase() !== 'about',
  );
  const longest = runs.sort((a, b) => b.length - a.length)[0];
  return longest && longest.length > 1 ? longest : null;
}

/**
 * Headings that mark the end of the top card and the start of the cards below.
 * Not section keys: About, Featured and Activity are not sections we return, but
 * they are just as good a boundary.
 */
const CARD_HEADINGS = new Set([
  ...HEADINGS.keys(),
  'about',
  'featured',
  'activity',
  'highlights',
  'interests',
]);

/**
 * Visible text runs of the top card, in order.
 *
 * Taken as everything in `<main>` up to the first card heading, rather than by
 * climbing out from an element inside the card. Climbing looks tidier but picks
 * a boundary that is one wrapper too tight: it stops above the follower count,
 * which then reads as absent on every profile.
 *
 * Returns the runs for `readCard` to interpret rather than interpreting them
 * here, so the rendered page and the plain fetch share one set of rules about
 * what a headline or a location looks like.
 */
export function topCardRuns(html: string): string[] {
  const $ = cheerio.load(html);
  $('script, style, noscript').remove();

  const main = $('main').first();
  if (main.length === 0) return [];

  const runs = leafRuns($, main);
  const end = runs.findIndex((run) => CARD_HEADINGS.has(headingKey(run)));
  return end > 0 ? runs.slice(0, end) : runs.slice(0, 24);
}
