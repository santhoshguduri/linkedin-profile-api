/**
 * Peak memory across one operation, measured the way the kernel measures it.
 *
 * A container that passes its instance limit is killed, not thrown at. There is
 * no exception, no stack and no final log line -- the last thing written is
 * whatever happened to be mid-flight, and the next thing is a startup banner.
 * That failure is invisible to any amount of `console.log`, because the code
 * never reaches the next statement. What is visible is the approach, so the
 * approach is what gets recorded.
 */
import { readFileSync } from 'node:fs';

/**
 * The cgroup's own accounting, v2 first and v1 behind it.
 *
 * Node's RSS is the wrong number to report here. Chromium is a separate process
 * tree and is by far the larger half of a render, but the limit that gets
 * enforced covers every process in the cgroup -- so a lookup can be comfortably
 * within Node's heap and still be killed. Reading the cgroup counts the browser.
 */
const USAGE_FILES = ['/sys/fs/cgroup/memory.current', '/sys/fs/cgroup/memory/memory.usage_in_bytes'];
const LIMIT_FILES = ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes'];

function readBytes(paths: readonly string[]): number | null {
  for (const path of paths) {
    try {
      const value = Number.parseInt(readFileSync(path, 'utf8').trim(), 10);
      // v2 writes "max" for unlimited, and v1 writes a number near 2^63.
      if (Number.isFinite(value) && value > 0 && value < Number.MAX_SAFE_INTEGER) return value;
    } catch {
      /* not this cgroup layout, or not in a container at all */
    }
  }
  return null;
}

const toMb = (bytes: number): number => Math.round(bytes / 1024 / 1024);

/** Whole-container usage where that is knowable, this process where it is not. */
const used = (): number => readBytes(USAGE_FILES) ?? process.memoryUsage.rss();

/**
 * The ceiling this deployment is held to, or null off a limited cgroup. Logged
 * beside the peak so one line answers how close a lookup came, rather than two.
 */
export function memoryLimitMb(): number | null {
  const limit = readBytes(LIMIT_FILES);
  return limit === null ? null : toMb(limit);
}

export function trackPeakMemory(sampleMs = 250): () => number {
  let peak = used();
  const timer = setInterval(() => {
    const now = used();
    if (now > peak) peak = now;
  }, sampleMs);
  // Diagnostics must never be the reason an idle process stays alive.
  timer.unref();
  return () => {
    clearInterval(timer);
    return toMb(peak);
  };
}
