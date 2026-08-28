/**
 * Outbound pacing and failure containment.
 *
 * Live probing established that LinkedIn returns HTTP 999 after roughly six rapid
 * requests from one IP, and that the block then persists even for logged-out
 * pages. So pacing here is a correctness requirement, not a politeness gesture:
 * exceeding it costs the whole session, not just one request.
 */

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Refills continuously rather than in discrete windows, so bursts can't stack up. */
export class TokenBucket {
  #tokens: number;
  #lastRefill = Date.now();

  constructor(
    private readonly capacity: number,
    private readonly refillPerMinute: number,
  ) {
    this.#tokens = capacity;
  }

  #refill(): void {
    const now = Date.now();
    const elapsedMin = (now - this.#lastRefill) / 60_000;
    if (elapsedMin <= 0) return;
    this.#tokens = Math.min(this.capacity, this.#tokens + elapsedMin * this.refillPerMinute);
    this.#lastRefill = now;
  }

  /** Resolves once a token is available. Serialised by the caller's await chain. */
  async take(): Promise<void> {
    for (;;) {
      this.#refill();
      if (this.#tokens >= 1) {
        this.#tokens -= 1;
        return;
      }
      const deficit = 1 - this.#tokens;
      await sleep(Math.max(50, Math.ceil((deficit / this.refillPerMinute) * 60_000)));
    }
  }

  get available(): number {
    this.#refill();
    return Math.floor(this.#tokens);
  }
}

export type BreakerState = 'closed' | 'open' | 'half-open';

/**
 * Once LinkedIn starts returning 999 the correct move is to stop entirely — more
 * requests extend the block. The breaker converts that into a fast 503 with a
 * Retry-After instead of a queue of doomed requests.
 */
export class CircuitBreaker {
  #failures = 0;
  #openedAt = 0;

  constructor(
    private readonly threshold: number,
    private readonly cooldownMs: number,
  ) {}

  get state(): BreakerState {
    if (this.#failures < this.threshold) return 'closed';
    return Date.now() - this.#openedAt >= this.cooldownMs ? 'half-open' : 'open';
  }

  /** Seconds until the breaker will next allow a request through. */
  get retryAfterSeconds(): number {
    if (this.state !== 'open') return 0;
    return Math.max(1, Math.ceil((this.cooldownMs - (Date.now() - this.#openedAt)) / 1000));
  }

  recordSuccess(): void {
    this.#failures = 0;
    this.#openedAt = 0;
  }

  recordFailure(): void {
    this.#failures++;
    if (this.#failures >= this.threshold) this.#openedAt = Date.now();
  }
}

/** Full jitter — avoids retry convoys when several requests back off together. */
export function backoffDelay(attempt: number, baseMs = 1000, capMs = 30_000): number {
  const ceiling = Math.min(capMs, baseMs * 2 ** attempt);
  return Math.floor(Math.random() * ceiling);
}

/** Bounded-concurrency map. Sections fetch in parallel but never faster than the bucket allows. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index] as T, index);
    }
  });
  await Promise.all(workers);
  return results;
}
