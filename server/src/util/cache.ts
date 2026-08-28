/**
 * TTL + LRU cache. The single most effective mitigation for LinkedIn's HTTP 999
 * throttle: repeat lookups of the same profile cost zero outbound requests.
 */
export class TtlCache<T> {
  #map = new Map<string, { value: T; expiresAt: number }>();
  #hits = 0;
  #misses = 0;

  constructor(
    private readonly maxEntries: number,
    private readonly ttlMs: number,
  ) {}

  get(key: string): T | undefined {
    const hit = this.#map.get(key);
    if (!hit) {
      this.#misses++;
      return undefined;
    }
    if (Date.now() > hit.expiresAt) {
      this.#map.delete(key);
      this.#misses++;
      return undefined;
    }
    // Refresh recency: delete + re-set moves the key to the tail of the Map.
    this.#map.delete(key);
    this.#map.set(key, hit);
    this.#hits++;
    return hit.value;
  }

  set(key: string, value: T): void {
    if (this.ttlMs <= 0) return;
    if (this.#map.has(key)) this.#map.delete(key);
    this.#map.set(key, { value, expiresAt: Date.now() + this.ttlMs });
    while (this.#map.size > this.maxEntries) {
      const oldest = this.#map.keys().next();
      if (oldest.done) break;
      this.#map.delete(oldest.value);
    }
  }

  delete(key: string): void {
    this.#map.delete(key);
  }

  clear(): void {
    this.#map.clear();
  }

  stats() {
    return { size: this.#map.size, hits: this.#hits, misses: this.#misses };
  }
}
