/**
 * Tests for the parts of the sign-in that do not need a browser.
 *
 * Classifying LinkedIn's post-password page is the piece most likely to break
 * when LinkedIn rewords something, and it is the piece that decides whether the
 * caller is told to look at their phone or to type a code -- so it is worth
 * pinning down against the wordings actually seen in the wild.
 */
import { describe, expect, it } from 'vitest';
import {
  CHALLENGE_MESSAGES,
  classifyChallenge,
  credentialErrorFrom,
} from '../src/linkedin/login.js';

const CHECKPOINT = 'https://www.linkedin.com/checkpoint/challenge/AgH0abc123';

describe('classifyChallenge', () => {
  it('recognises the mobile app approval prompt', () => {
    expect(
      classifyChallenge(
        CHECKPOINT,
        'Check your LinkedIn app\nWe sent a notification to your phone. Tap Approve to continue.',
      ),
    ).toBe('app-approval');
  });

  it('recognises the approval prompt under a different wording', () => {
    expect(
      classifyChallenge(CHECKPOINT, 'Open your LinkedIn app and approve this sign-in request.'),
    ).toBe('app-approval');
  });

  it('recognises a verification code page', () => {
    expect(
      classifyChallenge(CHECKPOINT, "Enter the 6-digit code we sent to s•••@example.com"),
    ).toBe('code');
  });

  it('trusts a visible code input even when the copy says nothing useful', () => {
    expect(classifyChallenge(CHECKPOINT, 'Quick check', true)).toBe('code');
  });

  /**
   * The approval page offers "having trouble? enter a code instead" underneath,
   * so a naive check would classify it as a code challenge and sit waiting for
   * input that is never coming.
   */
  it('prefers app approval when the page mentions both', () => {
    expect(
      classifyChallenge(
        CHECKPOINT,
        'Check your LinkedIn app to approve this sign-in. Trouble? Enter the code instead.',
      ),
    ).toBe('app-approval');
  });

  /** A CAPTCHA page also says "verification", so it has to be checked first. */
  it('puts a captcha ahead of everything else', () => {
    expect(
      classifyChallenge(CHECKPOINT, "Let's do a quick security check before verification."),
    ).toBe('captcha');
  });

  it('falls back to unknown rather than guessing', () => {
    expect(classifyChallenge(CHECKPOINT, 'Something went wrong.')).toBe('unknown');
  });

  it('matches on the URL as well as the body', () => {
    expect(classifyChallenge('https://www.linkedin.com/checkpoint/challenge/captcha', '')).toBe(
      'captcha',
    );
  });

  it('has a message for every kind it can return', () => {
    for (const kind of ['app-approval', 'code', 'captcha', 'unknown'] as const) {
      expect(CHALLENGE_MESSAGES[kind]).toBeTruthy();
    }
  });
});

describe('credentialErrorFrom', () => {
  it("reads back LinkedIn's own wording for an unknown email", () => {
    expect(
      credentialErrorFrom("Hmm, we don't recognize that email. Please try again."),
    ).toBe("Hmm, we don't recognize that email. Please try again.");
  });

  it('reads back a wrong password', () => {
    expect(credentialErrorFrom("That's not the right password. Please try again.")).toBe(
      "That's not the right password. Please try again.",
    );
  });

  it('returns nothing for a page that is not complaining about credentials', () => {
    expect(credentialErrorFrom('Welcome back. Check your LinkedIn app.')).toBeUndefined();
  });
});
