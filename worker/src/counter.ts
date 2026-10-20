// The only thing the registry stores about use: one integer per plugin id.
// No address, no time, no version, no user agent.

import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";

export class Counter extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS downloads (id TEXT PRIMARY KEY, n INTEGER NOT NULL)",
    );
  }

  increment(id: string): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO downloads (id, n) VALUES (?, 1) ON CONFLICT(id) DO UPDATE SET n = n + 1",
      id,
    );
  }

  all(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const row of this.ctx.storage.sql.exec<{ id: string; n: number }>(
      "SELECT id, n FROM downloads",
    )) {
      out[row.id] = row.n;
    }
    return out;
  }
}
