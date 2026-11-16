import type { AppRequest, Handler } from "../../domain/types/RequestTypes.js";
import { tooManyRequestsError } from "../../errors.js";

/**
 * Fixed-window counters per key, in memory (one process; a multi-instance deployment needs a shared store).
 * Old windows are dropped as they are passed, so memory stays bounded by the keys seen in one window.
 */
export class RateLimiter {
  private readonly hits = new Map<string, { start: number; n: number }>();
  private lastSweep = 0;

  constructor(private readonly limit: number, private readonly windowMs: number, private readonly now: () => number = Date.now) {}

  /** Counts one hit for `key`; false once the key is over its limit for this window. */
  hit(key: string): boolean {
    const t = this.now();
    this.sweep(t);
    const w = this.hits.get(key);
    if (!w || t - w.start >= this.windowMs) {
      this.hits.set(key, { start: t, n: 1 });
      return true;
    }
    w.n++;
    return w.n <= this.limit;
  }

  /** Whether `key` is already over its limit, without counting a hit. */
  blocked(key: string): boolean {
    const w = this.hits.get(key);
    return !!w && this.now() - w.start < this.windowMs && w.n > this.limit;
  }

  private sweep(t: number): void {
    if (t - this.lastSweep < this.windowMs) return;
    this.lastSweep = t;
    for (const [k, w] of this.hits) if (t - w.start >= this.windowMs) this.hits.delete(k);
  }
}

/**
 * The caller's address. The service binds to localhost or sits behind a tunnel, so X-Forwarded-For is only
 * trusted when TRUST_PROXY=1 says a proxy we run sets it.
 */
export function clientKey(req: AppRequest, trustProxy: boolean): string {
  if (trustProxy) {
    const fwd = String(req.headers["x-forwarded-for"] ?? "").split(",")[0]?.trim();
    if (fwd) return fwd;
  }
  return req.socket?.remoteAddress ?? "unknown";
}

/** Refuses a caller (429) after `limiter` has seen too many hits from it in the window. */
export const rateLimit = (limiter: RateLimiter, what: string, trustProxy = false): Handler => (req) => {
  if (!limiter.hit(`${what}:${clientKey(req, trustProxy)}`)) throw tooManyRequestsError(`too many ${what} requests from this address; try again later`);
};
