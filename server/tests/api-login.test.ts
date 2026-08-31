/**
 * The parts of the mobile-app sign-in that do not need a live account.
 *
 * Everything here is one JSON body and one cookie jar in, one result out --
 * which is the whole point of splitting the interpreter away from the two fetch
 * calls. LinkedIn's result codes are the thing most likely to change under us,
 * so they are pinned here rather than discovered in production.
 */
import { describe, expect, it } from 'vitest';
import { classifyByUrl, interpretAuthResponse, toOutcome } from '../src/linkedin/apiLogin.js';

const jar = (entries: Record<string, string>) => new Map(Object.entries(entries));

describe('interpretAuthResponse', () => {
  it('returns the session cookie a PASS was issued', () => {
    const result = interpretAuthResponse(
      { login_result: 'PASS' },
      jar({ li_at: 'AQED-token', JSESSIONID: '"ajax:99"' }),
    );

    expect(result.status).toBe('authenticated');
    if (result.status !== 'authenticated') return;
    expect(result.credentials.liAt).toBe('AQED-token');
    expect(result.credentials.jsessionId).toBe('"ajax:99"');
  });

  it('records the user agent the cookie was minted under', () => {
    // LinkedIn ties a session to its client, so a cookie that cannot say which
    // one issued it gets replayed as the wrong browser on every later request.
    const result = interpretAuthResponse({ login_result: 'PASS' }, jar({ li_at: 'x' }));

    expect(result.status).toBe('authenticated');
    if (result.status !== 'authenticated') return;
    expect(result.credentials.userAgent).toBeTruthy();
  });

  it('refuses a PASS that carried no cookie rather than reporting success', () => {
    expect(() => interpretAuthResponse({ login_result: 'PASS' }, jar({}))).toThrow(
      /issued no session cookie/i,
    );
  });

  it('carries the cookies forward with a challenge', () => {
    // The checkpoint is bound to the session that created it; without these the
    // browser handed the URL would restart the sign-in from the form.
    const result = interpretAuthResponse(
      {
        login_result: 'CHALLENGE',
        challenge_url: 'https://www.linkedin.com/checkpoint/challenge/AgH123',
      },
      jar({ JSESSIONID: '"ajax:7"', bcookie: 'v=2' }),
    );

    expect(result.status).toBe('challenge');
    if (result.status !== 'challenge') return;
    expect(result.url).toBe('https://www.linkedin.com/checkpoint/challenge/AgH123');
    expect(result.cookies.get('bcookie')).toBe('v=2');
  });

  it('absolutises a relative challenge url', () => {
    const result = interpretAuthResponse(
      { login_result: 'CHALLENGE', challenge_url: '/checkpoint/challenge/AgH123' },
      jar({}),
    );

    expect(result.status).toBe('challenge');
    if (result.status !== 'challenge') return;
    expect(result.url).toBe('https://www.linkedin.com/checkpoint/challenge/AgH123');
  });

  it('fails a challenge with nowhere to send the caller', () => {
    const result = interpretAuthResponse({ login_result: 'CHALLENGE' }, jar({}));
    expect(result.status).toBe('failed');
  });

  it('names the refusals it knows', () => {
    const bad = interpretAuthResponse({ login_result: 'BAD_PASSWORD' }, jar({}));
    expect(bad).toEqual({
      status: 'failed',
      code: 'BAD_PASSWORD',
      message: expect.stringMatching(/password/i),
    });

    const locked = interpretAuthResponse({ login_result: 'ACCOUNT_LOCKED' }, jar({}));
    expect(locked).toEqual({
      status: 'failed',
      code: 'ACCOUNT_LOCKED',
      message: expect.stringMatching(/locked/i),
    });
  });

  it('keeps an unrecognised code in the message', () => {
    // A code in the text is the difference between a five-minute fix and an
    // afternoon of guessing at what LinkedIn started returning.
    const result = interpretAuthResponse({ login_result: 'SOMETHING_NEW' }, jar({}));

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    expect(result.message).toContain('SOMETHING_NEW');
  });

  it('treats a missing result as a refusal rather than a success', () => {
    expect(interpretAuthResponse({}, jar({ li_at: 'x' })).status).toBe('failed');
  });
});

describe('classifyByUrl', () => {
  it('reads a captcha checkpoint as unanswerable', () => {
    expect(classifyByUrl('https://www.linkedin.com/checkpoint/challenge/captchaV2')).toBe('captcha');
  });

  it('reads a two-step url as wanting a typed code', () => {
    expect(classifyByUrl('https://www.linkedin.com/checkpoint/two-step-verification')).toBe('code');
  });

  it('defaults an unnamed checkpoint to the phone approval', () => {
    // Deliberately not "unknown": the manager only waits on waitable kinds, and
    // failing fast here strands somebody still reaching for their phone.
    expect(classifyByUrl('https://www.linkedin.com/checkpoint/challenge/AgH123')).toBe(
      'app-approval',
    );
  });
});

describe('toOutcome', () => {
  it('drops the url and cookies a caller must never see', () => {
    const outcome = toOutcome({
      status: 'challenge',
      code: 'CHALLENGE',
      kind: 'app-approval',
      message: 'tap it',
      url: 'https://www.linkedin.com/checkpoint/challenge/AgH123',
      cookies: jar({ JSESSIONID: '"ajax:7"' }),
    });

    expect(outcome).toEqual({ status: 'challenge', kind: 'app-approval', message: 'tap it' });
  });

  it('drops the raw verdict from a terminal result too', () => {
    // The code is for the log, not for the caller: it is LinkedIn's vocabulary
    // and it changes without notice, so nothing outside this module builds on it.
    expect(toOutcome({ status: 'failed', code: 'BAD_PASSWORD', message: 'nope' })).toEqual({
      status: 'failed',
      message: 'nope',
    });
  });
});
