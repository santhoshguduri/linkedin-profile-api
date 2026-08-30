import { useCallback, useEffect, useRef, useState } from 'react';
import { ProfileApiError, fetchProfile, type ApiError, type ProfileResponse } from './api';

/**
 * What the server is doing, and roughly when.
 *
 * These are elapsed-time estimates, not events pushed from the server: the
 * lookup is a single request/response, so the client genuinely cannot know which
 * stage is running. The labels and timings mirror the real pipeline measured
 * against live profiles, and the last one is open-ended so the sequence can
 * never claim to have finished while the request is still out.
 *
 * The point is to make a 40-second wait legible rather than to report progress
 * precisely. Anything more truthful means streaming the stages from the server.
 */
const STAGES: readonly { at: number; label: string; detail: string }[] = [
  { at: 0, label: 'Resolving the profile URL', detail: 'Normalising the link and checking the session' },
  { at: 1_200, label: 'Opening LinkedIn', detail: 'Loading the page in a real browser with your session' },
  { at: 4_000, label: 'Waiting for the page to fill in', detail: 'LinkedIn loads experience and education after the shell' },
  { at: 14_000, label: 'Collecting the full lists', detail: 'Opening the “show all” pages for the truncated sections' },
  { at: 30_000, label: 'Extracting fields', detail: 'Reading the rendered page and validating the response' },
];

type State =
  | { status: 'idle' }
  | { status: 'loading'; stage: number }
  | { status: 'error'; error: ApiError }
  | { status: 'success'; data: ProfileResponse; roundTripMs: number };

export { STAGES };

export function useProfileLookup() {
  const [state, setState] = useState<State>({ status: 'idle' });
  /** Cancels the previous lookup so a slow response cannot overwrite a newer one. */
  const inFlight = useRef<AbortController | null>(null);
  const timers = useRef<number[]>([]);

  const clearTimers = () => {
    for (const id of timers.current) window.clearTimeout(id);
    timers.current = [];
  };

  // A lookup abandoned by unmounting must not keep firing setState.
  useEffect(() => clearTimers, []);

  const run = useCallback(async (url: string, refresh: boolean) => {
    const trimmed = url.trim();
    if (!trimmed) return;

    inFlight.current?.abort();
    clearTimers();
    const controller = new AbortController();
    inFlight.current = controller;

    setState({ status: 'loading', stage: 0 });
    const started = performance.now();

    // Scheduled up front rather than chained, so a stage that is already overdue
    // when the response lands simply never fires.
    timers.current = STAGES.slice(1).map((stage, index) =>
      window.setTimeout(() => {
        if (!controller.signal.aborted) setState({ status: 'loading', stage: index + 1 });
      }, stage.at),
    );

    try {
      const data = await fetchProfile(trimmed, { refresh, signal: controller.signal });
      if (controller.signal.aborted) return;
      clearTimers();
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
      clearTimers();

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
