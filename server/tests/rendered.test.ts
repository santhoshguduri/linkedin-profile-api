import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  extractRenderedAbout,
  extractRenderedSections,
  topCardRuns,
} from '../src/linkedin/extract/rendered.js';

/**
 * Carved out of a real authenticated render, with every attribute the parser
 * does not read stripped off -- which is also what removes the CSRF token, so
 * this is safe to commit where the capture it came from is not.
 *
 * Keeping real markup matters more here than anywhere else in the suite. The
 * whole point of `rendered.ts` is that LinkedIn's DOM has no stable classes, so
 * a fixture written by hand would only prove the extractor agrees with my guess
 * about the DOM rather than with the DOM.
 */
const html = await readFile(
  fileURLToPath(new URL('./fixtures/rendered-profile.html', import.meta.url)),
  'utf8',
);

describe('rendered section extraction', () => {
  const sections = extractRenderedSections(html);

  it('finds sections by heading text', () => {
    expect([...sections.keys()].sort()).toEqual(['education', 'experience']);
  });

  it('reads one entry per role, not one per keyed element', () => {
    // Regression guard: each experience row contains a keyed <a> of its own, so
    // counting every `componentkey` would double the list.
    const experience = sections.get('experience') ?? [];
    expect(experience).toHaveLength(3);
    expect(experience.map((e) => e.lines[0])).toEqual(['Co-chair', 'Founder', 'Co-founder']);
  });

  it('keeps the text runs a mapper needs, in document order', () => {
    expect(sections.get('experience')?.[0]?.lines).toEqual([
      'Co-chair',
      'Gates Foundation',
      '2000 – Present',
    ]);
  });

  it('handles the education container shape, which is not the experience one', () => {
    // Experience rows are `entity-collection-item-<hash>`; education rows are
    // plain-UUID keys separated by <hr>. Both must yield entries.
    const education = sections.get('education') ?? [];
    expect(education.map((e) => e.lines[0])).toEqual(['Harvard University', 'Lakeside School']);
    expect(education[0]?.lines).toContain('1973 – 1975');
  });

  it('carries the entity logo and link', () => {
    const first = sections.get('experience')?.[0];
    expect(first?.image?.url).toMatch(/^https:\/\/media\.licdn\.com\//);
    expect(first?.links[0]).toMatch(/^https:\/\/www\.linkedin\.com\//);
  });

  it('drops no-content runs like the show-all toggle', () => {
    const runs = [...sections.values()].flat().flatMap((e) => e.lines);
    expect(runs.some((line) => /^show all/i.test(line))).toBe(false);
  });
});

/**
 * No capture exercises skills, certifications or languages -- neither profile I
 * have rendered has them. What is testable offline is the part that is specific
 * to those sections: the heading map. The container underneath is one of the two
 * shapes already covered above, so this relabels a real one rather than inventing
 * markup and calling the invention evidence.
 */
describe('heading map', () => {
  const relabel = (heading: string) =>
    extractRenderedSections(html.split('>Education<').join(`>${heading}<`));

  it.each([
    ['Skills', 'skills'],
    ['Licenses & Certifications', 'certifications'],
    ['Licenses and Certifications', 'certifications'],
    ['Languages', 'languages'],
    ['Honors & awards', 'honors'],
    ['Volunteering', 'volunteer'],
    ['Volunteer Experience', 'volunteer'],
    ['Projects', 'projects'],
    ['Publications', 'publications'],
    ['Courses', 'courses'],
    ['Organizations', 'organizations'],
  ])('routes %s to the %s section', (heading, key) => {
    expect(relabel(heading).get(key)?.length).toBeGreaterThan(0);
  });

  it.each(['Skills (40)', 'Skills (1,204)', 'Licenses & certifications (3)'])(
    'ignores the entry count LinkedIn appends to %s',
    (heading) => {
      // Regression: the map was matched exactly, so a populated section -- the
      // only kind worth counting -- was the kind that silently vanished.
      expect([...relabel(heading).keys()]).toHaveLength(2);
    },
  );

  it('ignores a heading it does not know', () => {
    expect([...relabel('Nonsense').keys()]).toEqual(['experience']);
  });

  it('collapses a heading LinkedIn repeats into one section', () => {
    // "Education" appears as an <h2> twice on this page. Taking the last would
    // pick up whichever copy sits inside a "people also viewed" card.
    expect(html.match(/<h2[^>]*>Education<\/h2>/g)).toHaveLength(2);
    expect(extractRenderedSections(html).get('education')).toHaveLength(2);
  });
});

describe('rendered about and top card', () => {
  it('takes the expanded about text, not the see-more toggle', () => {
    expect(extractRenderedAbout(html)).toMatch(/^Chair of the Gates Foundation\./);
  });

  it('stops the top card at the first section heading', () => {
    const runs = topCardRuns(html);
    expect(runs[0]).toBe('Bill Gates');
    expect(runs[1]).toBe('Chair, Gates Foundation and Founder, Breakthrough Energy');
    expect(runs).toContain('Seattle, Washington, United States');
    expect(runs).toContain('40,605,159 followers');
    expect(runs.some((r) => /^About$/i.test(r))).toBe(false);
  });
});
