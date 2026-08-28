/**
 * Maps harvested entity cards onto the typed section schemas.
 *
 * Fields are located by shape, not by position: the date line is found by looking
 * for a year or "Present", and the lines around it are interpreted relative to
 * it. That survives LinkedIn adding, removing or reordering a line — which a
 * fixed index-based mapping would not.
 */
import type { RawEntity } from './entities.js';
import type {
  Certification,
  DateRange,
  Education,
  Experience,
  GenericEntry,
  Language,
  Skill,
} from '../../schema/profile.js';

/**
 * A line is a date line if it names a year or says "Present". The year range is
 * 1800-2099 rather than 19xx/20xx so historical education entries still parse.
 */
const DATE_LINE = /(?:\b(?:1[89]|20)\d{2}\b|\bpresent\b)/i;
const DURATION_RE = /\b\d+\s*(?:yrs?|years?|mos?|months?)\b/i;
const MIDDOT = /\s*[·•]\s*/;

/** "Jan 2020 - Present · 3 yrs 2 mos" */
export function parseDateRange(text: string | undefined): DateRange | null {
  if (!text || !DATE_LINE.test(text)) return null;

  const parts = text.split(MIDDOT).map((p) => p.trim()).filter(Boolean);
  const rangePart = parts.find((p) => DATE_LINE.test(p)) ?? parts[0] ?? text;
  const durationPart = parts.find((p) => DURATION_RE.test(p) && p !== rangePart) ?? null;

  const split = /^(.+?)\s*[-–—]\s*(.+)$/.exec(rangePart);
  const start = split?.[1]?.trim() ?? rangePart.trim();
  const end = split?.[2]?.trim() ?? null;

  return {
    text: text.trim(),
    start: start || null,
    end,
    duration: durationPart,
    isCurrent: end !== null && /present/i.test(end),
  };
}

/** Splits "Acme Corp · Full-time" into its parts. */
function splitDotted(line: string | undefined): string[] {
  return line ? line.split(MIDDOT).map((p) => p.trim()).filter(Boolean) : [];
}

const firstLink = (entity: RawEntity, pattern: RegExp): string | null =>
  entity.links.find((l) => pattern.test(l)) ?? null;

const absolute = (href: string | null): string | null =>
  href === null ? null : href.startsWith('http') ? href : `https://www.linkedin.com${href}`;

export function toExperience(entity: RawEntity): Experience {
  const { lines } = entity;
  const dateIndex = lines.findIndex((l, i) => i > 0 && DATE_LINE.test(l));

  const companyLine = dateIndex > 1 ? lines.slice(1, dateIndex).join(' ') : lines[1];
  const [company = null, employmentType = null] = splitDotted(companyLine);

  const afterDate = dateIndex >= 0 ? lines[dateIndex + 1] : undefined;
  const location = afterDate && !DATE_LINE.test(afterDate) ? (splitDotted(afterDate)[0] ?? null) : null;

  const bodyStart = dateIndex >= 0 ? dateIndex + (location ? 2 : 1) : 1;
  const body = lines.slice(bodyStart).filter((l) => !/^skills:/i.test(l));
  const skillLine = lines.find((l) => /^skills:/i.test(l));

  return {
    title: lines[0] ?? null,
    company,
    employmentType,
    location,
    dateRange: dateIndex >= 0 ? parseDateRange(lines[dateIndex]) : null,
    description: body.length > 0 ? body.join('\n') : null,
    skills: skillLine
      ? skillLine.replace(/^skills:\s*/i, '').split(MIDDOT).map((s) => s.trim()).filter(Boolean)
      : [],
    companyUrl: absolute(firstLink(entity, /\/company\//)),
    logo: entity.image,
  };
}

export function toEducation(entity: RawEntity): Education {
  const { lines } = entity;
  const dateIndex = lines.findIndex((l, i) => i > 0 && DATE_LINE.test(l));
  const degreeLine = lines[1];
  const [degree = null, fieldOfStudy = null] = degreeLine
    ? degreeLine.split(/\s*,\s*/).map((p) => p.trim())
    : [];

  const gradeLine = lines.find((l) => /^grade:/i.test(l));
  const bodyStart = dateIndex >= 0 ? dateIndex + 1 : 2;

  return {
    school: lines[0] ?? null,
    degree,
    fieldOfStudy,
    grade: gradeLine ? gradeLine.replace(/^grade:\s*/i, '').trim() : null,
    dateRange: dateIndex >= 0 ? parseDateRange(lines[dateIndex]) : null,
    description:
      lines.slice(bodyStart).filter((l) => !/^grade:/i.test(l)).join('\n') || null,
    schoolUrl: absolute(firstLink(entity, /\/school\/|\/company\//)),
    logo: entity.image,
  };
}

const ENDORSEMENT_RE = /(\d[\d,]*)\s*endorsement/i;

export function toSkill(entity: RawEntity): Skill | null {
  const { lines } = entity;
  const name = lines[0];
  if (!name) return null;

  const endorseLine = lines.find((l) => ENDORSEMENT_RE.test(l));
  const count = endorseLine ? ENDORSEMENT_RE.exec(endorseLine)?.[1] : undefined;

  return {
    name,
    endorsementCount: count ? Number(count.replace(/,/g, '')) : null,
    // Lines below the skill name name the roles that vouch for it.
    context: lines.slice(1).filter((l) => !ENDORSEMENT_RE.test(l)),
  };
}

export function toCertification(entity: RawEntity): Certification {
  const { lines } = entity;
  const issuedLine = lines.find((l) => /issued|expire/i.test(l));
  const idLine = lines.find((l) => /credential id/i.test(l));

  return {
    name: lines[0] ?? null,
    issuer: lines[1] && lines[1] !== issuedLine ? (splitDotted(lines[1])[0] ?? null) : null,
    issuedDate: issuedLine ? (/issued\s*(.+?)(?:\s*[·•]|$)/i.exec(issuedLine)?.[1]?.trim() ?? null) : null,
    expiryDate: issuedLine
      ? (/expir\w*\s*(.+?)(?:\s*[·•]|$)/i.exec(issuedLine)?.[1]?.trim() ?? null)
      : null,
    credentialId: idLine ? idLine.replace(/^.*credential id\s*/i, '').trim() : null,
    credentialUrl: absolute(firstLink(entity, /^https?:\/\/(?!www\.linkedin\.com)/)),
    logo: entity.image,
  };
}

export function toLanguage(entity: RawEntity): Language | null {
  const name = entity.lines[0];
  if (!name) return null;
  return { name, proficiency: entity.lines[1] ?? null };
}

/**
 * Fallback shape for sections we do not model field-by-field (projects, honors,
 * volunteering, publications, courses, organizations). Preserving the raw lines
 * means a consumer can still read a section whose layout we have not mapped.
 */
export function toGenericEntry(entity: RawEntity): GenericEntry {
  const { lines } = entity;
  const dateIndex = lines.findIndex((l, i) => i > 0 && DATE_LINE.test(l));
  const bodyStart = dateIndex >= 0 ? dateIndex + 1 : 2;

  return {
    title: lines[0] ?? null,
    subtitle: dateIndex === 1 ? null : (lines[1] ?? null),
    caption: dateIndex >= 0 ? (lines[dateIndex] ?? null) : null,
    description: lines.slice(bodyStart).join('\n') || null,
    url: absolute(entity.links[0] ?? null),
  };
}

/**
 * An entity is worth keeping only if it has a name/title. Cards harvested from
 * navigation chrome and empty-state placeholders reduce to nothing useful.
 */
export function isMeaningful(entity: RawEntity): boolean {
  const first = entity.lines[0];
  return typeof first === 'string' && first.length > 1 && first.length < 400;
}

/**
 * Entities are harvested page-wide, so the same card can surface twice (once from
 * the flight tree, once from a nested list). Keyed on the joined lines because
 * two genuinely distinct entries never render identical text.
 */
export function dedupeEntities(entities: RawEntity[]): RawEntity[] {
  const seen = new Set<string>();
  const out: RawEntity[] = [];
  for (const entity of entities) {
    const key = entity.lines.join('\u0000');
    if (key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    out.push(entity);
  }
  return out;
}
