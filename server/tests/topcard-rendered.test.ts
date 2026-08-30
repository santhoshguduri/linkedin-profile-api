import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { extractIdentity, extractTopcard } from '../src/linkedin/extract/topcard.js';

const html = await readFile(
  fileURLToPath(new URL('./fixtures/rendered-profile.html', import.meta.url)),
  'utf8',
);

/**
 * A rendered page has no flight payload left to read the name out of, so the
 * document title is the source -- and LinkedIn decorates it at both ends.
 */
describe('name from the document title', () => {
  const identity = extractIdentity({}, html);
  const card = extractTopcard({}, html, identity);

  it('strips the unread-notification count and the LinkedIn suffix', () => {
    // The suffix pattern was once written /\s\*\|\s*LinkedIn$/, where `\*` is a
    // literal asterisk rather than a repeat, so it never matched and the name
    // came through as "(5) Bill Gates | LinkedIn".
    expect(card.fullName).toBe('Bill Gates');
    expect(card.firstName).toBe('Bill');
    expect(card.lastName).toBe('Gates');
  });

  it('finds the headline, which depends on the name being clean', () => {
    // The headline is located as the run after the name, so a decorated name
    // silently nulls it rather than failing loudly.
    expect(card.headline).toBe('Chair, Gates Foundation and Founder, Breakthrough Energy');
  });

  it('reads location and follower count off the card', () => {
    expect(card.location?.text).toBe('Seattle, Washington, United States');
    expect(card.location?.country).toBe('United States');
    expect(card.followerCount).toBe(40605159);
  });
});

describe('identity on a rendered page', () => {
  it('recovers the profile id from the SDUI component key', () => {
    // Hydration drops every `urn:li:fsd_profile:` string; the id survives only
    // as part of `sdui.profile.card.ref<id>Topcard`.
    expect(html).not.toContain('urn:li:fsd_profile:');
    expect(extractIdentity({}, html).profileUrn).toBe(
      'urn:li:fsd_profile:ACoAAA8BYqEBCGLg_vT_ca6mMEqkpp9nVffJ3hc',
    );
  });

  it('does not swallow the card name into the id', () => {
    // Ids are a fixed 39 chars and the card name is concatenated straight on,
    // so a greedy match would return "...Topcard".
    expect(extractIdentity({}, html).profileUrn).not.toMatch(/Topcard/);
  });
});
