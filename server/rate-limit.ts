export class RateLimiter {
  private readonly buckets = new Map<string, { count: number; reset: number }>();

  take(key: string, limit: number, now = Date.now()): boolean {
    const existing = this.buckets.get(key);
    if (existing && existing.reset > now) {
      if (existing.count >= limit) return false;
      existing.count++;
      return true;
    }
    // Bound memory even under a large number of distinct source addresses.
    if (this.buckets.size >= 20_000) {
      this.prune(now);
      if (this.buckets.size >= 20_000) return false;
    }
    this.buckets.set(key, { count: 1, reset: now + 60_000 });
    return true;
  }

  prune(now = Date.now()): void {
    for (const [key, bucket] of this.buckets) if (bucket.reset <= now) this.buckets.delete(key);
  }
}
