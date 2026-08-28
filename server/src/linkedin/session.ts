/**
 * Session identity: the exact header set a real Chrome navigation sends, plus a
 * cookie jar and detection of what LinkedIn actually returned.
 *
 * The header set is copied from a captured working request. It matters: the
 * profile page is fetched as a *document navigation*, not an XHR, so
 * `sec-fetch-dest: document` / `sec-fetch-mode: navigate` and
 * `upgrade-insecure-requests` are part of what makes the response come back with
 * a rehydration payload rather than a login wall.
 */
import { CookieJar } from 'tough-cookie';
import type { Config } from '../config.js';
import type { SessionCredentials } from './credentials.js';

export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * Client hints must agree with the User-Agent — a Chrome 131 UA paired with a
 * Chrome 151 sec-ch-ua is a bot signal. The brand list is derived from the UA so
 * overriding one keeps the other consistent.
 */
export function clientHintsFor(userAgent: string): string {
  const major = /Chrome\/(\d+)/.exec(userAgent)?.[1] ?? '131';
  return `"Google Chrome";v="${major}", "Chromium";v="${major}", "Not=A?Brand";v="24"`;
}

export function navigationHeaders(userAgent: string): Record<string, string> {
  return {
    accept:
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
    'accept-language': 'en-US,en;q=0.9',
    'cache-control': 'max-age=0',
    priority: 'u=0, i',
    'sec-ch-ua': clientHintsFor(userAgent),
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'document',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-site': 'same-origin',
    'sec-fetch-user': '?1',
    'upgrade-insecure-requests': '1',
    'user-agent': userAgent,
  };
}

const LINKEDIN_ORIGIN = 'https://www.linkedin.com';

/**
 * Seeds a jar for one identity. Only li_at is required; in credentials mode the
 * jar starts empty and the sign-in fills it.
 *
 * The ambient cookies (bcookie, lidc, lang) come from config because they are
 * deployment-level fingerprint material, not per-user identity.
 */
export function createCookieJar(credentials: SessionCredentials, config: Config): CookieJar {
  const jar = new CookieJar();
  const set = (name: string, value: string | undefined) => {
    if (!value) return;
    jar.setCookieSync(
      `${name}=${value}; Domain=.linkedin.com; Path=/; Secure; HttpOnly`,
      LINKEDIN_ORIGIN,
    );
  };

  set('li_at', credentials.liAt);
  if (credentials.jsessionId) set('JSESSIONID', `"${credentials.jsessionId}"`);
  set('bcookie', config.LI_BCOOKIE);
  set('lidc', config.LI_LIDC);
  set('liap', 'true');
  set('lang', 'v=2&lang=en-us');

  return jar;
}

/** True once the jar holds a usable LinkedIn session cookie. */
export async function hasSessionCookie(jar: CookieJar): Promise<boolean> {
  const cookies = await jar.getCookies('https://www.linkedin.com/feed/');
  return cookies.some((c) => c.key === 'li_at' && Boolean(c.value));
}

export type AuthState =
  | 'authenticated'
  | 'authwall'
  | 'challenge'
  | 'not-found'
  | 'throttled'
  | 'unknown';

/**
 * Classifies a response body.
 *
 * Critically, the logged-out authwall is served with **HTTP 200**, not 401 — the
 * captured `fixtures/authwall.html` is a 1.5 KB script that redirects to
 * /authwall. Status code alone can never be trusted here.
 */
export function detectAuthState(status: number, body: string): AuthState {
  if (status === 999 || status === 429) return 'throttled';

  const head = body.slice(0, 4000);

  if (/\/authwall\?trk=|sessionRedirect=|"authwall"/i.test(head)) return 'authwall';
  if (/checkpoint\/challenge|\/uas\/login|captcha-internal|security verification/i.test(head)) {
    return 'challenge';
  }
  if (status === 404) return 'not-found';
  if (body.includes('__como_rehydration__')) return 'authenticated';
  if (status === 401 || status === 403) return 'authwall';

  return 'unknown';
}
