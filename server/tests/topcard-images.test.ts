import { describe, expect, it } from 'vitest';
import { extractProfileImages } from '../src/linkedin/extract/topcard.js';

const IDENTITY = {
  firstName: null,
  lastName: null,
  publicIdentifier: null,
  canonicalUrl: null,
  pictureHint: null,
} as unknown as Parameters<typeof extractProfileImages>[2];

const PHOTO = 'https://media.licdn.com/dms/image/v2/D5603AQabcdefghij/profile-displayphoto-shrink_200_200/0/1?e=1';

/**
 * A top card whose <img> carries no id.
 *
 * This is the shape that took the API down with a 500. The DOM fallback used to
 * rebuild a selector out of each image's id, so an image without one produced a
 * bare "#" in the selector list and the CSS parser threw "Expected name, found
 * #". LinkedIn does not put an id on every avatar -- williamhgates and
 * satyanadella happened to have them, other profiles do not.
 */
const CARD_WITHOUT_IDS = `<!doctype html><html><body><main><section>
  <a href="/in/x/overlay/contact-info">Contact info</a>
  <img alt="Profile photo" src="${PHOTO}">
</section></main></body></html>`;

describe('extractProfileImages DOM fallback', () => {
  it('does not throw when a top-card image has no id', () => {
    expect(() => extractProfileImages({}, CARD_WITHOUT_IDS, IDENTITY)).not.toThrow();
  });

  it('still finds the photo without relying on an id', () => {
    const { picture } = extractProfileImages({}, CARD_WITHOUT_IDS, IDENTITY);
    expect(picture?.url).toBe(PHOTO);
  });

  it('survives a card with no images at all', () => {
    const empty = '<!doctype html><html><body><main><section></section></main></body></html>';
    expect(() => extractProfileImages({}, empty, IDENTITY)).not.toThrow();
    expect(extractProfileImages({}, empty, IDENTITY).picture).toBeNull();
  });

  it('tolerates ids that are not valid CSS identifiers', () => {
    // React's useId emits values like «r0», which are not selectable either.
    const reactish = CARD_WITHOUT_IDS.replace('<img alt', '<img id="\u00abr0\u00bb" alt');
    expect(() => extractProfileImages({}, reactish, IDENTITY)).not.toThrow();
  });
});
