import type { Counter } from "./counter";
import type { Limiter } from "./limiter";

export interface Env {
  /** The built registry tree: index.json, index.json.sig, stats.json, plugins/... */
  ARTIFACTS: R2Bucket;
  COUNTER: DurableObjectNamespace<Counter>;
  LIMITER: DurableObjectNamespace<Limiter>;
  /** Requests per client address per minute; "0" turns the limit off. */
  RATE_REQS_PER_MIN?: string;
}
