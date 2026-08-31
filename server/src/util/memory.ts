/**
 * Peak resident memory across one operation.
 *
 * A container that exceeds its instance limit is killed, not thrown at. There
 * is no exception, no stack and no final log line -- the last thing written is
 * whatever happened to be mid-flight, and the next thing is a startup banner.
 * That failure is invisible to any amount of `console.log`, because the code
 * never reaches the next statement.
 *
 * What is visible is the approach, so the approach is what gets recorded. Every
 * completed lookup reports how close it came to the ceiling, which turns "it
 * died and we do not know why" into a number that was already climbing on the
 * lookups that survived.
 */
export function trackPeakRss(sampleMs = 250): () => number {
  let peak = process.memoryUsage.rss();
  const timer = setInterval(() => {
    const rss = process.memoryUsage.rss();
    if (rss > peak) peak = rss;
  }, sampleMs);
  // Diagnostics must never be the reason an idle process stays alive.
  timer.unref();
  return () => {
    clearInterval(timer);
    return Math.round(peak / 1024 / 1024);
  };
}
