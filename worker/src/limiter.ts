// A lightweight abuse limiter, in memory only, as light as the relay's. It is
// keyed by a short hash of the client address (never the address itself), kept
// for at most a minute and never written to storage. If it is evicted the
// counters simply start over, which is fine for a rate limit.

import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";

const WINDOW_MS = 60_000;
const MAX_ENTRIES = 20_000;

interface Entry {
  start: number;
  count: number;
}

export interface Admission {
  ok: boolean;
  /** Seconds until the refused client may try again. */
  retryAfter: number;
}

export class Limiter extends DurableObject<Env> {
  private readonly entries = new Map<string, Entry>();
  private lastSweep = 0;

  /** Admit one request. `perMin` of 0 admits everything. */
  admit(client: string, perMin: number): Admission {
    if (perMin <= 0) return { ok: true, retryAfter: 0 };
    const now = Date.now();
    this.sweep(now);
    let e = this.entries.get(client);
    if (!e || now - e.start >= WINDOW_MS) {
      e = { start: now, count: 0 };
      this.entries.set(client, e);
    }
    if (e.count >= perMin) {
      return { ok: false, retryAfter: Math.ceil((e.start + WINDOW_MS - now) / 1000) };
    }
    e.count += 1;
    return { ok: true, retryAfter: 0 };
  }

  private sweep(now: number): void {
    if (now - this.lastSweep < WINDOW_MS && this.entries.size < MAX_ENTRIES) return;
    this.lastSweep = now;
    for (const [k, e] of this.entries) {
      if (now - e.start >= WINDOW_MS) this.entries.delete(k);
    }
    // Still over the cap under a flood of addresses: start over.
    if (this.entries.size >= MAX_ENTRIES) this.entries.clear();
  }
}
