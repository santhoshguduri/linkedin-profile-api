import { useCallback, useRef, useState } from 'react';
import { ProfileApiError, fetchProfile, type ApiError, type ProfileResponse } from './api';

type State =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; error: ApiError }
  | { status: 'success'; data: ProfileResponse; roundTripMs: number };

export function useProfileLookup() {
  const [state, setState] = useState<State>({ status: 'idle' });
  /** Cancels the previous lookup so a slow response cannot overwrite a newer one. */
  const inFlight = useRef<AbortController | null>(null);

  const run = useCallback(async (url: string, refresh: boolean) => {
    const trimmed = url.trim();
    if (!trimmed) return;

    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;

    setState({ status: 'loading' });
    const started = performance.now();

    try {
      const data = await fetchProfile(trimmed, { refresh, signal: controller.signal });
      if (controller.signal.aborted) return;
      setState({
        status: 'success',
        data,
        roundTripMs: Math.round(performance.now() - started),
      });

      // Make the lookup linkable and survivable across a reload.
      const next = new URL(window.location.href);
      next.searchParams.set('url', trimmed);
      window.history.replaceState(null, '', next);
    } catch (error) {
      // An abort means a newer lookup replaced this one; it is not a failure.
      if (controller.signal.aborted) return;

      setState({
        status: 'error',
        error:
          error instanceof ProfileApiError
            ? {
                code: error.code,
                message: error.message,
                ...(error.hint ? { hint: error.hint } : {}),
                ...(error.retryAfterSeconds
                  ? { retryAfterSeconds: error.retryAfterSeconds }
                  : {}),
              }
            : { code: 'INTERNAL', message: String(error) },
      });
    }
  }, []);

  return { state, run };
}
