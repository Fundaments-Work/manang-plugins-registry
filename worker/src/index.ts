// Manang plugin registry: a read-only front for one R2 bucket.
//
//   GET|HEAD /index.json, /index.json.sig, /stats.json
//   GET|HEAD /plugins/<id>/README.md
//   GET|HEAD /plugins/<id>/<version>/<id>-<version>.manangplugin and README.md
//
// Everything else is a 404. The Worker never writes the bucket. It keeps one
// counter per plugin (a full download, or the first range of one) and nothing
// else about who asked; there are no logs.

import { Counter } from "./counter";
import type { Env } from "./env";
import {
  cacheControl,
  contentType,
  etagMatches,
  keyFor,
  parseRange,
  route,
  type Route,
} from "./http";
import { Limiter } from "./limiter";

export { Counter, Limiter };

const SECURITY: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
  "cross-origin-resource-policy": "cross-origin",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
};

// GET only, any origin: the web version of Manang will fetch from here.
const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-expose-headers": "ETag, Content-Length, Content-Range, Accept-Ranges",
};

function headers(extra: Record<string, string> = {}): Headers {
  return new Headers({ ...SECURITY, ...CORS, ...extra });
}

function plain(
  status: number,
  text: string,
  extra: Record<string, string> = {},
): Response {
  return new Response(text, {
    status,
    headers: headers({
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      ...extra,
    }),
  });
}

/** First 8 bytes of SHA-256, hex: enough to bucket by, useless to recover from. */
async function shortHash(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest, 0, 8)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function perMinute(env: Env): number {
  const n = Number(env.RATE_REQS_PER_MIN ?? "600");
  return Number.isFinite(n) && n >= 0 ? n : 600;
}

async function sha256Etag(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  const hex = [...new Uint8Array(digest, 0, 16)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `"${hex}"`;
}

/** The seed from the bucket plus the live counters. */
async function statsBody(env: Env): Promise<string> {
  let seed: Record<string, number> = {};
  const obj = await env.ARTIFACTS.get("stats.json");
  if (obj) {
    try {
      const parsed = (await obj.json()) as { downloads?: Record<string, number> };
      seed = parsed.downloads ?? {};
    } catch {
      seed = {};
    }
  }
  const live = await env.COUNTER.get(env.COUNTER.idFromName("downloads")).all();
  const merged: Record<string, number> = {};
  for (const id of [...new Set([...Object.keys(seed), ...Object.keys(live)])].sort()) {
    const s = seed[id];
    merged[id] =
      (Number.isInteger(s) && s !== undefined && s > 0 ? s : 0) + (live[id] ?? 0);
  }
  return `${JSON.stringify({ downloads: merged }, null, 2)}\n`;
}

function notModified(etag: string, r: Route): Response {
  return new Response(null, {
    status: 304,
    headers: headers({ etag, "cache-control": cacheControl(r) }),
  });
}

async function serveStats(request: Request, env: Env): Promise<Response> {
  const body = await statsBody(env);
  const etag = await sha256Etag(body);
  const r: Route = { kind: "stats" };
  if (etagMatches(request.headers.get("if-none-match"), etag))
    return notModified(etag, r);
  return new Response(request.method === "HEAD" ? null : body, {
    headers: headers({
      "content-type": contentType(r),
      "content-length": String(new TextEncoder().encode(body).length),
      "cache-control": cacheControl(r),
      etag,
    }),
  });
}

async function serveObject(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  r: Route,
  key: string,
): Promise<Response> {
  const head = await env.ARTIFACTS.head(key);
  if (!head) return plain(404, "not found\n");
  const etag = head.httpEtag; // quoted and strong
  if (etagMatches(request.headers.get("if-none-match"), etag))
    return notModified(etag, r);

  const size = head.size;
  const base: Record<string, string> = {
    "content-type": contentType(r),
    "cache-control": cacheControl(r),
    "accept-ranges": "bytes",
    etag,
    "last-modified": head.uploaded.toUTCString(),
    ...(r.kind === "artifact"
      ? { "content-disposition": `attachment; filename="${r.file}"` }
      : {}),
  };

  if (request.method === "HEAD") {
    return new Response(null, {
      headers: headers({ ...base, "content-length": String(size) }),
    });
  }

  // A stale If-Range means "send me the whole file".
  const ifRange = request.headers.get("if-range");
  const range =
    ifRange !== null && ifRange.trim() !== etag
      ? ({ kind: "none" } as const)
      : parseRange(request.headers.get("range"), size);

  if (range.kind === "unsatisfiable") {
    return new Response(null, {
      status: 416,
      headers: headers({
        ...base,
        "content-range": `bytes */${size}`,
        "content-length": "0",
      }),
    });
  }

  const obj =
    range.kind === "range"
      ? await env.ARTIFACTS.get(key, {
          range: { offset: range.start, length: range.end - range.start + 1 },
        })
      : await env.ARTIFACTS.get(key);
  if (!obj) return plain(404, "not found\n");

  // Count a full download or the first range of one; never HEAD, 304, 416 or a
  // later range of a resumed or parallel fetch. Only the plugin id is recorded.
  if (r.kind === "artifact" && (range.kind === "none" || range.start === 0)) {
    ctx.waitUntil(
      env.COUNTER.get(env.COUNTER.idFromName("downloads"))
        .increment(r.id)
        .catch(() => undefined),
    );
  }

  if (range.kind === "range") {
    return new Response(obj.body, {
      status: 206,
      headers: headers({
        ...base,
        "content-range": `bytes ${range.start}-${range.end}/${size}`,
        "content-length": String(range.end - range.start + 1),
      }),
    });
  }
  return new Response(obj.body, {
    headers: headers({ ...base, "content-length": String(size) }),
  });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: headers({
          allow: "GET, HEAD, OPTIONS",
          "access-control-allow-methods": "GET, HEAD, OPTIONS",
          "access-control-allow-headers": "Range, If-None-Match, If-Range",
          "access-control-max-age": "86400",
        }),
      });
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return plain(405, "method not allowed\n", { allow: "GET, HEAD, OPTIONS" });
    }

    const url = new URL(request.url);
    const r = route(url.pathname);
    if (r === null) return plain(404, "not found\n");

    const limit = perMinute(env);
    if (limit > 0) {
      try {
        const client = await shortHash(
          request.headers.get("CF-Connecting-IP") ?? "local",
        );
        const shard = Number.parseInt(client.slice(0, 2), 16) % 4;
        const verdict = await env.LIMITER.get(
          env.LIMITER.idFromName(`shard-${shard}`),
        ).admit(client, limit);
        if (!verdict.ok) {
          return plain(429, "too many requests; slow down\n", {
            "retry-after": String(verdict.retryAfter),
          });
        }
      } catch {
        // The limiter is best effort: if it is unavailable, serve the request.
      }
    }

    if (r.kind === "stats") return serveStats(request, env);
    const key = keyFor(r);
    if (key === null) return plain(404, "not found\n");
    return serveObject(request, env, ctx, r, key);
  },
} satisfies ExportedHandler<Env>;
