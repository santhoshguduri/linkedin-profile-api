import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseProfileUrl, detailsUrlFor, contactInfoUrlFor } from '../src/linkedin/url.js';
import {
  detectAuthState,
  clientHintsFor,
  navigationHeaders,
  createCookieJar,
} from '../src/linkedin/session.js';
import {
  resolveSession,
  sessionFromEnv,
  hasAnyCredential,
  parseCookieHeader,
  mergeCredentials,
} from '../src/linkedin/credentials.js';
import { loadConfig } from '../src/config.js';
import { AppError } from '../src/util/errors.js';

/** The real logged-out response captured from LinkedIn. */
const AUTHWALL_HTML = readFileSync(new URL('../fixtures/authwall.html', import.meta.url), 'utf8');

describe('parseProfileUrl', () => {
  it.each([
    'https://www.linkedin.com/in/santhosh-guduri-6b1b49322/',
    'https://www.linkedin.com/in/santhosh-guduri-6b1b49322',
    'http://www.linkedin.com/in/santhosh-guduri-6b1b49322/',
    'www.linkedin.com/in/santhosh-guduri-6b1b49322',
    'linkedin.com/in/santhosh-guduri-6b1b49322/',
    'santhosh-guduri-6b1b49322',
  ])('accepts %s', (input) => {
    expect(parseProfileUrl(input).publicIdentifier).toBe('santhosh-guduri-6b1b49322');
  });

  it('accepts locale subdomains', () => {
    expect(parseProfileUrl('https://in.linkedin.com/in/someone').publicIdentifier).toBe('someone');
    expect(parseProfileUrl('https://fr.linkedin.com/in/someone/').publicIdentifier).toBe('someone');
  });

  it('strips tracking query strings and deep sub-routes', () => {
    expect(
      parseProfileUrl('https://www.linkedin.com/in/someone/?originalSubdomain=in&trk=abc')
        .publicIdentifier,
    ).toBe('someone');
    expect(
      parseProfileUrl('https://www.linkedin.com/in/someone/details/experience/').publicIdentifier,
    ).toBe('someone');
    expect(
      parseProfileUrl('https://www.linkedin.com/in/someone/overlay/contact-info/')
        .publicIdentifier,
    ).toBe('someone');
  });

  it('handles the legacy /pub/ form', () => {
    expect(parseProfileUrl('https://www.linkedin.com/pub/jane-doe/1/2/3').publicIdentifier).toBe(
      'jane-doe',
    );
  });

  it('decodes percent-encoded non-Latin slugs', () => {
    const encoded = 'https://www.linkedin.com/in/%E5%B1%B1%E7%94%B0';
    expect(parseProfileUrl(encoded).publicIdentifier).toBe('山田');
  });

  it('normalises every accepted form to the same canonical URL', () => {
    const a = parseProfileUrl('https://in.linkedin.com/in/someone?trk=x').canonicalUrl;
    const b = parseProfileUrl('someone').canonicalUrl;
    expect(a).toBe(b);
    expect(a).toBe('https://www.linkedin.com/in/someone/');
  });

  it.each([
    ['', 'empty input'],
    ['https://example.com/in/someone', 'non-LinkedIn host'],
    ['https://www.linkedin.com/company/acme', 'company URL'],
    ['https://www.linkedin.com/feed/', 'no profile path'],
  ])('rejects %s (%s)', (input) => {
    expect(() => parseProfileUrl(input)).toThrow(AppError);
  });

  it('builds details and contact-info URLs from the slug', () => {
    expect(detailsUrlFor('someone', 'experience')).toBe(
      'https://www.linkedin.com/in/someone/details/experience/',
    );
    expect(contactInfoUrlFor('someone')).toBe(
      'https://www.linkedin.com/in/someone/overlay/contact-info/',
    );
  });
});

describe('detectAuthState', () => {
  it('classifies the real authwall fixture despite its HTTP 200 status', () => {
    // This is the crux: LinkedIn serves the logged-out wall with a 200.
    expect(AUTHWALL_HTML).not.toContain('__como_rehydration__');
    expect(detectAuthState(200, AUTHWALL_HTML)).toBe('authwall');
  });

  it('classifies a page carrying a rehydration payload as authenticated', () => {
    const html = '<html><script>window.__como_rehydration__ = ["0:null"]</script></html>';
    expect(detectAuthState(200, html)).toBe('authenticated');
  });

  it('classifies HTTP 999 as throttled', () => {
    expect(detectAuthState(999, '')).toBe('throttled');
    expect(detectAuthState(429, '')).toBe('throttled');
  });

  it('classifies security checkpoints', () => {
    expect(detectAuthState(200, '<html>checkpoint/challenge</html>')).toBe('challenge');
  });

  it('classifies 404 as not-found', () => {
    expect(detectAuthState(404, '<html>nothing here</html>')).toBe('not-found');
  });

  it('does not guess when the response is unrecognisable', () => {
    expect(detectAuthState(200, '<html>something else entirely</html>')).toBe('unknown');
  });
});

describe('request identity', () => {
  it('derives client hints from the User-Agent major version', () => {
    expect(clientHintsFor('... Chrome/131.0.0.0 Safari/537.36')).toContain('"Google Chrome";v="131"');
    expect(clientHintsFor('... Chrome/151.0.0.0 Safari/537.36')).toContain('"Chromium";v="151"');
  });

  it('sends document-navigation headers, not XHR headers', () => {
    const headers = navigationHeaders('Chrome/131.0.0.0');
    expect(headers['sec-fetch-dest']).toBe('document');
    expect(headers['sec-fetch-mode']).toBe('navigate');
    expect(headers['upgrade-insecure-requests']).toBe('1');
    expect(headers.accept).toContain('text/html');
    // XHR/API headers must be absent: this must look like a document load.
    expect(headers['x-restli-protocol-version']).toBeUndefined();
    expect(headers['csrf-token']).toBeUndefined();
  });
});

describe('cookie jar', () => {
  const config = loadConfig({
    LI_AT: 'fake-li-at-value',
    LI_JSESSIONID: 'ajax:1234567890',
  } as NodeJS.ProcessEnv);

  it('seeds the session cookies LinkedIn requires', () => {
    const jar = createCookieJar(sessionFromEnv(config).credentials, config);
    const cookies = jar.getCookieStringSync('https://www.linkedin.com/in/someone/');
    expect(cookies).toContain('li_at=fake-li-at-value');
    expect(cookies).toContain('JSESSIONID=');
  });

  it('strips surrounding quotes from a pasted JSESSIONID', () => {
    const quoted = loadConfig({
      LI_AT: 'x',
      LI_JSESSIONID: '"ajax:42"',
    } as NodeJS.ProcessEnv);
    expect(quoted.LI_JSESSIONID).toBe('ajax:42');
  });

  it('treats blank credentials as absent', () => {
    const blank = loadConfig({ LI_AT: '   ', LI_JSESSIONID: '' } as NodeJS.ProcessEnv);
    expect(blank.hasCredentials).toBe(false);
  });

  it('keeps one caller cookies out of another jar', () => {
    const mine = createCookieJar(resolveSession({ liAt: 'mine' }).credentials, config);
    const theirs = createCookieJar(resolveSession({ liAt: 'theirs' }).credentials, config);
    expect(mine.getCookieStringSync('https://www.linkedin.com/')).toContain('li_at=mine');
    expect(theirs.getCookieStringSync('https://www.linkedin.com/')).not.toContain('li_at=mine');
  });
});

describe('session resolution', () => {
  it('treats a cookie as the only way in', () => {
    expect(resolveSession({ liAt: 'cookie' }).mode).toBe('cookie');
    expect(resolveSession({ jsessionId: 'ajax:1' }).mode).toBe('none');
  });

  it('gives each identity a distinct, non-reversible key', () => {
    const a = resolveSession({ liAt: 'token-a' });
    const b = resolveSession({ liAt: 'token-b' });
    expect(a.key).not.toBe(b.key);
    expect(a.key).not.toContain('token-a');
    // Same material must map to the same pooled session.
    expect(resolveSession({ liAt: 'token-a' }).key).toBe(a.key);
  });

  it('treats an empty payload as no session at all', () => {
    expect(hasAnyCredential({})).toBe(false);
    expect(hasAnyCredential({ liAt: 'x' })).toBe(true);
    expect(resolveSession({ liAt: '   ' }).mode).toBe('none');
  });
});

describe('pasted cookie parsing', () => {
  it('pulls the session out of a copied Cookie request header', () => {
    const header =
      'bcookie="v=2&abc"; bscookie="v=1&xyz"; li_at=AQEDATEST_VALUE_1234567890; ' +
      'JSESSIONID="ajax:9876543210"; lidc="b=OB01:s=O"; UserMatchHistory=AQK1';
    expect(parseCookieHeader(header)).toEqual({
      liAt: 'AQEDATEST_VALUE_1234567890',
      jsessionId: 'ajax:9876543210',
    });
  });

  it('drops every cookie other than the two it needs', () => {
    // A copied header carries analytics and fingerprinting cookies. Forwarding
    // them on the caller's behalf would be collecting more than the job needs.
    const parsed = parseCookieHeader('li_at=AQEDA1; _pxvid=track-me; dfpfpt=fingerprint');
    expect(Object.keys(parsed).filter((k) => parsed[k as keyof typeof parsed])).toEqual(['liAt']);
  });

  it('accepts a newline-separated paste from the DevTools cookie table', () => {
    expect(parseCookieHeader('li_at=AQEDA2\nJSESSIONID=ajax:11\nlang=v=2&lang=en-us')).toEqual({
      liAt: 'AQEDA2',
      jsessionId: 'ajax:11',
    });
  });

  it('accepts a bare li_at value with no name attached', () => {
    const bare = 'AQEDAREALLOOKINGTOKENVALUE123456';
    expect(parseCookieHeader(bare)).toEqual({ liAt: bare });
  });

  it('does not mistake arbitrary prose for a token', () => {
    expect(parseCookieHeader('paste your cookie here')).toEqual({
      liAt: undefined,
      jsessionId: undefined,
    });
    expect(parseCookieHeader('')).toEqual({});
    expect(parseCookieHeader(undefined)).toEqual({});
  });

  it('strips the quotes LinkedIn wraps JSESSIONID in', () => {
    expect(parseCookieHeader('li_at=A1; JSESSIONID="ajax:42"').jsessionId).toBe('ajax:42');
  });

  it('keeps a value containing = intact', () => {
    // Cookie values legitimately contain "=", so only the first one separates.
    expect(parseCookieHeader('li_at=AQ==pad; lang=v=2').liAt).toBe('AQ==pad');
  });

  it('lets an explicit field win over the same field in a paste', () => {
    const merged = mergeCredentials(
      { liAt: 'explicit' },
      parseCookieHeader('li_at=pasted; JSESSIONID=ajax:7'),
    );
    expect(merged).toEqual({ liAt: 'explicit', jsessionId: 'ajax:7' });
  });

  it('resolves a pasted header to the same identity as the cookie alone', () => {
    const fromPaste = resolveSession(parseCookieHeader('li_at=SAME; JSESSIONID=ajax:1'));
    const fromField = resolveSession({ liAt: 'SAME', jsessionId: 'ajax:1' });
    expect(fromPaste.key).toBe(fromField.key);
    expect(fromPaste.mode).toBe('cookie');
  });
});
