/**
 * Contact info lives behind the /overlay/contact-info/ route. The overlay renders
 * one block per channel, each block being an icon, a label and a value — so the
 * parser keys on the label text, which is stable, rather than on the block markup.
 */
import * as cheerio from 'cheerio';
import type { ContactInfo } from '../../schema/profile.js';
import { cleanLines, flightTextRuns } from './entities.js';

const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/;
const PHONE_RE = /\+?[\d][\d\s().-]{6,}\d/;

const LABELS = {
  websites: /^websites?$/i,
  email: /^e-?mail$/i,
  phone: /^phone$/i,
  twitter: /^(twitter|x)$/i,
  birthday: /^birthday$/i,
  connected: /^connected$/i,
  profile: /^(your profile|profile)$/i,
} as const;

const empty = (): ContactInfo => ({
  profileUrl: null,
  websites: [],
  email: null,
  phone: null,
  twitter: null,
  birthday: null,
  connectedDate: null,
});

/**
 * Walks the flattened label/value stream. Everything between one known label and
 * the next belongs to that label, which tolerates a channel rendering across
 * several lines (a website URL plus its "Company" qualifier, for example).
 */
function assign(contact: ContactInfo, label: string, values: string[]): void {
  const value = values.find((v) => v.length > 0);
  if (LABELS.websites.test(label)) {
    for (const v of values) {
      const url = /^https?:\/\//i.test(v) ? v : /\w\.\w/.test(v) ? `https://${v}` : null;
      if (url) contact.websites.push({ url, label: null });
      else if (contact.websites.length > 0) {
        // A qualifier such as "(Company)" trails the URL it describes.
        const last = contact.websites[contact.websites.length - 1];
        if (last) last.label = v.replace(/^[(]|[)]$/g, '');
      }
    }
  } else if (LABELS.email.test(label)) {
    contact.email = values.find((v) => EMAIL_RE.test(v))?.match(EMAIL_RE)?.[0] ?? null;
  } else if (LABELS.phone.test(label)) {
    contact.phone = values.find((v) => PHONE_RE.test(v))?.match(PHONE_RE)?.[0]?.trim() ?? null;
  } else if (LABELS.twitter.test(label)) {
    contact.twitter = value ?? null;
  } else if (LABELS.birthday.test(label)) {
    contact.birthday = value ?? null;
  } else if (LABELS.connected.test(label)) {
    contact.connectedDate = value ?? null;
  } else if (LABELS.profile.test(label) && value) {
    contact.profileUrl = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  }
}

function parseStream(runs: string[]): ContactInfo {
  const contact = empty();
  const labelAt = (s: string): string | null =>
    Object.values(LABELS).some((re) => re.test(s)) ? s : null;

  let current: string | null = null;
  let buffer: string[] = [];

  for (const run of runs) {
    const label = labelAt(run);
    if (label) {
      if (current) assign(contact, current, buffer);
      current = label;
      buffer = [];
    } else if (current) {
      buffer.push(run);
    }
  }
  if (current) assign(contact, current, buffer);
  return contact;
}

/** True when nothing at all was recovered — lets callers report the section missing. */
export function isEmptyContact(contact: ContactInfo): boolean {
  return (
    contact.websites.length === 0 &&
    contact.email === null &&
    contact.phone === null &&
    contact.twitter === null &&
    contact.birthday === null &&
    contact.connectedDate === null &&
    contact.profileUrl === null
  );
}

export function extractContactInfo(tree: unknown, html: string): ContactInfo {
  const $ = cheerio.load(html);
  const domRuns = cleanLines(
    $('section, .pv-contact-info, [class*="contact-info"]')
      .find('h3, span, a, div')
      .map((_, el) => $(el).text())
      .get(),
  );

  const fromDom = parseStream(domRuns);
  if (!isEmptyContact(fromDom)) {
    // Anchors carry the unshortened href; the visible text is often truncated.
    for (const href of $('a[href]').map((_, el) => $(el).attr('href') ?? '').get()) {
      if (href.startsWith('mailto:') && !fromDom.email) fromDom.email = href.slice(7);
      if (href.startsWith('tel:') && !fromDom.phone) fromDom.phone = href.slice(4);
    }
    return fromDom;
  }

  return parseStream(cleanLines(flightTextRuns(tree)));
}
