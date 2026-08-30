import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { extractRenderedSections, truncatedSections } from '../src/linkedin/extract/rendered.js';
import { toExperience } from '../src/linkedin/extract/sections.js';

/**
 * A real Experience card with two promotion histories in it, carved out of a
 * live render and then anonymised. The DOM shape is the thing under test; the
 * employment history it came from is not mine to publish.
 */
const html = await readFile(
  fileURLToPath(new URL('./fixtures/rendered-grouped-roles.html', import.meta.url)),
  'utf8',
);

const experience = extractRenderedSections(html).get('experience') ?? [];

describe('several roles at one employer', () => {
  it('yields one entry per role, not one per employer', () => {
    // Regression: the roles carry no componentkey of their own, so the whole
    // group used to collapse into a single job titled after the company.
    expect(experience).toHaveLength(5);
    expect(experience.map((e) => e.lines[0])).toEqual([
      'Staff Engineer',
      'Senior Engineer',
      'Engineer',
      'Developer',
      'Intern',
    ]);
  });

  it('folds the employer down onto each role', () => {
    const roles = experience.map(toExperience);
    expect(roles.map((r) => r.company)).toEqual([
      'Northwind',
      'Contoso',
      'Contoso',
      'Fabrikam',
      'Fabrikam',
    ]);
    expect(roles.every((r) => r.employmentType === 'Full-time')).toBe(true);
  });

  it('gives each role its own dates, not the group total', () => {
    const roles = experience.map(toExperience);
    expect(roles[1]?.dateRange?.text).toContain('Jun 2023 - Jun 2024');
    expect(roles[2]?.dateRange?.text).toContain('May 2022 - Jun 2024');
    expect(roles[0]?.dateRange?.isCurrent).toBe(true);
    expect(roles[1]?.dateRange?.isCurrent).toBe(false);
  });

  it('carries the employer location onto each role', () => {
    expect(toExperience(experience[1]!).location).toBe('Berlin, Germany');
    expect(toExperience(experience[3]!).location).toBe('Lisbon, Portugal');
  });

  it('does not mistake the company tenure for an employment type', () => {
    // The header reads "Full-time · 2 yrs 2 mos"; only the first part is a type.
    expect(experience.map((e) => e.lines[1])).not.toContain('Contoso · 2 yrs 2 mos');
  });
});

describe('truncated sections', () => {
  it('reports the routes whose card is only showing the first few entries', () => {
    expect([...truncatedSections(html)]).toContain('experience');
  });

  it('ignores details routes that are not profile sections', () => {
    const withNoise = html.replace(
      '<main>',
      '<main><a href="/in/a-person/details/recommendations/">Show all</a>' +
        '<a href="/in/a-person/details/add-connected-account/">Connect</a>',
    );
    const routes = [...truncatedSections(withNoise)];
    expect(routes).not.toContain('recommendations');
    expect(routes).not.toContain('add-connected-account');
  });
});
