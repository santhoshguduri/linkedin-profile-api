/**
 * Drives a LinkedIn sign-in from the browser.
 *
 * The whole reason this is a hook and not a function call is the approval step:
 * a sign-in can pause for as long as it takes somebody to find their phone, and
 * that pause has to be visible in the UI rather than hidden inside a promise
 * that never settles.
 *
 * An app approval is polled automatically -- there is nothing for the person to
 * do here, so making them press a button to check would be busywork. A code
 * challenge waits for input instead.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  cancelSignIn,
  ProfileApiError,
  signIn,
  verifySignIn,
  type ChallengeKind,
  type LinkedInSession,
} from './api';

export type SignInState =
  | { phase: 'idle' }
  | { phase: 'working' }
  | {
      phase: 'challenge';
      kind: ChallengeKind;
      handle: string;
      message: string;
      busy: boolean;
      /** When the wait began, so the UI can show that it is still live. */
      since: number;
    }
  | { phase: 'error'; message: string; hint?: string | undefined };

export function useSignIn(onSuccess: (session: LinkedInSession) => void) {
  const [state, setState] = useState<SignInState>({ phase: 'idle' });
  /** Guards against a poll that resolves after the dialog closed. */
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  /**
   * One place where every failure is turned into state, because the two entry
   * points fail in exactly the same ways and a challenge is not an error even
   * though it arrives as one.
   */
  const settle = useCallback(
    (error: unknown) => {
      if (!live.current) return;
      if (error instanceof ProfileApiError && error.code === 'CHALLENGE_PENDING') {
        const handle = error.challenge?.handle;
        if (handle) {
          setState((prev) => ({
            phase: 'challenge',
            kind: error.challenge?.challenge ?? 'unknown',
            handle,
            message: error.message,
            busy: false,
            // Kept across polls: each one comes back as another CHALLENGE_PENDING,
            // and restarting the clock every time would peg it at zero.
            since: prev.phase === 'challenge' ? prev.since : Date.now(),
          }));
          return;
        }
      }
      const hint = error instanceof ProfileApiError ? error.hint : undefined;
      setState({
        phase: 'error',
        message: error instanceof Error ? error.message : 'Sign-in failed.',
        hint,
      });
    },
    [],
  );

  const succeed = useCallback(
    (session: LinkedInSession) => {
      if (!live.current) return;
      setState({ phase: 'idle' });
      onSuccess(session);
    },
    [onSuccess],
  );

  const start = useCallback(
    async (username: string, password: string) => {
      setState({ phase: 'working' });
      try {
        succeed(await signIn(username, password));
      } catch (error) {
        settle(error);
      }
    },
    [settle, succeed],
  );

  const submitCode = useCallback(
    async (code: string) => {
      if (state.phase !== 'challenge') return;
      const { handle } = state;
      setState({ ...state, busy: true });
      try {
        succeed(await verifySignIn(handle, code));
      } catch (error) {
        settle(error);
      }
    },
    [settle, state, succeed],
  );

  /**
   * Polls an approval for as long as one is outstanding. The server holds each
   * call open for several seconds before answering, so this is a handful of
   * requests per minute, not a spin.
   *
   * `unknown` is polled alongside `app-approval`. It means LinkedIn showed a
   * screen the server could not classify, which in practice is usually an
   * approval prompt worded in a way the classifier has not seen -- and the tap
   * resolves it either way. Only a code challenge sits still here, because that
   * one genuinely needs somebody to type something.
   */
  useEffect(() => {
    if (state.phase !== 'challenge' || state.kind === 'code') return;
    let cancelled = false;
    const handle = state.handle;

    void (async () => {
      while (!cancelled) {
        const startedAt = Date.now();
        try {
          const session = await verifySignIn(handle);
          if (!cancelled) succeed(session);
          return;
        } catch (error) {
          // Still waiting is the expected answer, so it is the only one that loops.
          if (error instanceof ProfileApiError && error.code === 'CHALLENGE_PENDING') {
            // The server normally holds each poll open for ~20s. If one comes back
            // much faster -- a proxy cutting it short, say -- this backs off rather
            // than turning a five-minute wait into a request flood.
            const elapsed = Date.now() - startedAt;
            if (elapsed < 2_000) {
              await new Promise((resolve) => setTimeout(resolve, 2_000 - elapsed));
            }
            continue;
          }
          if (!cancelled) settle(error);
          return;
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [state, settle, succeed]);

  const reset = useCallback(() => {
    if (state.phase === 'challenge') void cancelSignIn(state.handle);
    setState({ phase: 'idle' });
  }, [state]);

  return { state, start, submitCode, reset };
}
