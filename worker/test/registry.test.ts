import { env as rawEnv } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import worker from "../src/index";

const env = rawEnv as unknown as Env;
const app = (exports as unknown as { default: Fetcher }).default;
const BASE = "https://registry.test";

const INDEX = `${JSON.stringify({ schema: 1, generated: "2026-10-19T08:00:00Z", plugins: [] })}\n`;
const SIG = `${"A".repeat(86)}==\n`;
// 1000 recognisable bytes, so ranges are easy to check.
const ARCHIVE = new Uint8Array(1000).map((_, i) => i % 251);
const ARCHIVE_PATH = "/plugins/word-count/0.2.0/word-count-0.2.0.manangplugin";
const README = "# Word count\n";

beforeAll(async () => {
  const put = (key: string, body: string | Uint8Array) => env.ARTIFACTS.put(key, body);
  await put("index.json", INDEX);
  await put("index.json.sig", SIG);
  await put(
    "stats.json",
    JSON.stringify({ downloads: { "word-count": 40, "seed-only": 5 } }),
  );
  await put("plugins/word-count/0.2.0/word-count-0.2.0.manangplugin", ARCHIVE);
  await put(
    "plugins/word-count/0.1.0/word-count-0.1.0.manangplugin",
    ARCHIVE.slice(0, 10),
  );
  await put("plugins/word-count/0.2.0/README.md", README);
  await put("plugins/word-count/README.md", README);
});

function get(path: string, init: RequestInit = {}): Promise<Response> {
  return app.fetch(`${BASE}${path}`, init);
}

async function downloads(): Promise<Record<string, number>> {
  const res = await get("/stats.json");
  return ((await res.json()) as { downloads: Record<string, number> }).downloads;
}

/** Wait for the (fire-and-forget) counter increment to land. */
async function counted(id: string, expected: number): Promise<void> {
  await vi.waitFor(async () => expect((await downloads())[id]).toBe(expected), {
    timeout: 3000,
    interval: 25,
  });
}

describe("serving files", () => {
  it("serves the index with its content type, caching and security headers", async () => {
    const res = await get("/index.json");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(INDEX);
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("strict-transport-security")).toContain("max-age=");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("content-length")).toBe(String(INDEX.length));
  });

  it("serves the signature as text", async () => {
    const res = await get("/index.json.sig");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(SIG);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
  });

  it("serves artifacts as immutable zips and the exact bytes", async () => {
    const res = await get(ARCHIVE_PATH);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="word-count-0.2.0.manangplugin"',
    );
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(ARCHIVE);
  });

  it("serves readmes: versioned ones immutable, the moving one short-lived", async () => {
    const versioned = await get("/plugins/word-count/0.2.0/README.md");
    expect(await versioned.text()).toBe(README);
    expect(versioned.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(versioned.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );
    const moving = await get("/plugins/word-count/README.md");
    expect(moving.status).toBe(200);
    expect(moving.headers.get("cache-control")).toBe("public, max-age=300");
  });

  it("answers 404 for everything else, including missing objects", async () => {
    for (const p of [
      "/",
      "/health",
      "/plugins/word-count",
      "/plugins/nope/1.0.0/nope-1.0.0.manangplugin",
      "/plugins/word-count/9.9.9/word-count-9.9.9.manangplugin",
      "/plugins/word-count/0.2.0/other-0.2.0.manangplugin",
      "/plugins/word-count/..%2Findex.json",
      "/index.json/",
    ]) {
      const res = await get(p);
      expect(res.status, p).toBe(404);
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
  });

  it("refuses other methods with 405 and answers OPTIONS", async () => {
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      const res = await get("/index.json", { method });
      expect(res.status, method).toBe(405);
      expect(res.headers.get("allow")).toBe("GET, HEAD, OPTIONS");
    }
    const pre = await get("/index.json", { method: "OPTIONS" });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe("*");
    expect(pre.headers.get("access-control-allow-methods")).toBe("GET, HEAD, OPTIONS");
    expect(pre.headers.get("access-control-allow-headers")).toContain("Range");
  });
});

describe("CORS", () => {
  it("allows any origin to read, on success and on errors", async () => {
    for (const p of ["/index.json", ARCHIVE_PATH, "/stats.json", "/nothing"]) {
      const res = await get(p, { headers: { origin: "https://app.example" } });
      expect(res.headers.get("access-control-allow-origin"), p).toBe("*");
    }
    const res = await get("/index.json");
    expect(res.headers.get("access-control-expose-headers")).toContain("ETag");
    expect(res.headers.get("access-control-expose-headers")).toContain("Content-Range");
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
  });
});

describe("conditional requests", () => {
  it("has a strong ETag and answers If-None-Match with 304", async () => {
    const first = await get("/index.json");
    const etag = first.headers.get("etag");
    expect(etag).toMatch(/^"[0-9a-f]+"$/);
    for (const header of [etag!, `"other", ${etag}`, "*", `W/${etag}`]) {
      const res = await get("/index.json", { headers: { "if-none-match": header } });
      expect(res.status, header).toBe(304);
      expect(await res.text()).toBe("");
      expect(res.headers.get("etag")).toBe(etag);
      expect(res.headers.get("cache-control")).toBe("public, max-age=300");
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
    }
    const miss = await get("/index.json", { headers: { "if-none-match": '"stale"' } });
    expect(miss.status).toBe(200);
  });

  it("works for artifacts and for stats", async () => {
    const a = await get(ARCHIVE_PATH);
    await a.arrayBuffer();
    const again = await get(ARCHIVE_PATH, {
      headers: { "if-none-match": a.headers.get("etag")! },
    });
    expect(again.status).toBe(304);
    const s = await get("/stats.json");
    const sTag = s.headers.get("etag")!;
    expect(sTag).toMatch(/^"[0-9a-f]{32}"$/);
    const cond = await get("/stats.json", { headers: { "if-none-match": sTag } });
    expect(cond.status).toBe(304);
  });
});

describe("range requests", () => {
  const bytes = (res: Response) => res.arrayBuffer().then((b) => new Uint8Array(b));

  it("serves a partial range with 206 and Content-Range", async () => {
    const res = await get(ARCHIVE_PATH, { headers: { range: "bytes=10-19" } });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 10-19/1000");
    expect(res.headers.get("content-length")).toBe("10");
    expect(await bytes(res)).toEqual(ARCHIVE.slice(10, 20));
  });

  it("supports open-ended and suffix ranges, and clamps the end", async () => {
    const open = await get(ARCHIVE_PATH, { headers: { range: "bytes=990-" } });
    expect(open.status).toBe(206);
    expect(open.headers.get("content-range")).toBe("bytes 990-999/1000");
    expect(await bytes(open)).toEqual(ARCHIVE.slice(990));
    const suffix = await get(ARCHIVE_PATH, { headers: { range: "bytes=-5" } });
    expect(suffix.headers.get("content-range")).toBe("bytes 995-999/1000");
    expect(await bytes(suffix)).toEqual(ARCHIVE.slice(995));
    const clamp = await get(ARCHIVE_PATH, { headers: { range: "bytes=995-5000" } });
    expect(clamp.headers.get("content-range")).toBe("bytes 995-999/1000");
  });

  it("answers 416 for an unsatisfiable range", async () => {
    const res = await get(ARCHIVE_PATH, { headers: { range: "bytes=1000-" } });
    expect(res.status).toBe(416);
    expect(res.headers.get("content-range")).toBe("bytes */1000");
  });

  it("ignores multi-range and malformed headers, and a stale If-Range", async () => {
    for (const range of ["bytes=0-1,5-6", "bytes=oops", "pages=1-2"]) {
      const res = await get(ARCHIVE_PATH, { headers: { range } });
      expect(res.status, range).toBe(200);
      expect((await bytes(res)).length).toBe(1000);
    }
    const stale = await get(ARCHIVE_PATH, {
      headers: { range: "bytes=0-9", "if-range": '"stale"' },
    });
    expect(stale.status).toBe(200);
    const fresh = await get(ARCHIVE_PATH);
    await fresh.arrayBuffer();
    const ok = await get(ARCHIVE_PATH, {
      headers: { range: "bytes=0-9", "if-range": fresh.headers.get("etag")! },
    });
    expect(ok.status).toBe(206);
  });

  it("works on the index too", async () => {
    const res = await get("/index.json", { headers: { range: "bytes=0-9" } });
    expect(res.status).toBe(206);
    expect(await res.text()).toBe(INDEX.slice(0, 10));
  });
});

describe("HEAD", () => {
  it("returns the headers of a GET without a body", async () => {
    for (const p of ["/index.json", ARCHIVE_PATH, "/stats.json"]) {
      const head = await get(p, { method: "HEAD" });
      const full = await get(p);
      const body = await full.arrayBuffer();
      expect(head.status, p).toBe(200);
      expect(await head.text(), p).toBe("");
      expect(head.headers.get("content-type"), p).toBe(
        full.headers.get("content-type"),
      );
      expect(head.headers.get("etag"), p).toBe(full.headers.get("etag"));
      expect(head.headers.get("content-length"), p).toBe(String(body.byteLength));
    }
    expect((await get("/nothing", { method: "HEAD" })).status).toBe(404);
  });
});

describe("download counter", () => {
  const path = (id: string) => `/plugins/${id}/1.0.0/${id}-1.0.0.manangplugin`;
  const seedPlugin = async (id: string) => {
    await env.ARTIFACTS.put(`plugins/${id}/1.0.0/${id}-1.0.0.manangplugin`, ARCHIVE);
  };

  it("counts full downloads and merges them with the seed in stats.json", async () => {
    const before = (await downloads())["word-count"] ?? 0;
    expect(before).toBeGreaterThanOrEqual(40);
    for (let i = 0; i < 3; i++) await (await get(ARCHIVE_PATH)).arrayBuffer();
    await counted("word-count", before + 3);
    const stats = await downloads();
    expect(stats["seed-only"]).toBe(5);
  });

  it("counts a first range once, and never later ranges, HEAD, 304 or 416", async () => {
    const id = "range-demo";
    await seedPlugin(id);
    const drain = async (init?: RequestInit) =>
      (await get(path(id), init)).arrayBuffer();

    await drain({ headers: { range: "bytes=0-99" } }); // first range: counts
    await counted(id, 1);
    await drain({ headers: { range: "bytes=100-199" } }); // a later range
    await drain({ headers: { range: "bytes=900-" } });
    await drain({ headers: { range: "bytes=5000-" } }); // 416
    await get(path(id), { method: "HEAD" });
    const etag = (await get(path(id), { method: "HEAD" })).headers.get("etag")!;
    await get(path(id), { headers: { "if-none-match": etag } }); // 304
    await get(path(id), { headers: { range: "bytes=-10" } }); // suffix, not the first range
    // Prove the above settled: a full download is the next (and last) count.
    await drain();
    await counted(id, 2);
  });

  it("counts only artifacts, never the index, readmes, signature or missing files", async () => {
    const id = "other-demo";
    await seedPlugin(id);
    await env.ARTIFACTS.put(`plugins/${id}/README.md`, README);
    await get("/index.json");
    await get("/index.json.sig");
    await get(`/plugins/${id}/README.md`);
    await get(`/plugins/${id}/9.9.9/${id}-9.9.9.manangplugin`); // 404: no counter row
    await get(path(id));
    await counted(id, 1);
    const stats = await downloads();
    expect(Object.keys(stats)).not.toContain("nonexistent");
    expect(stats[id]).toBe(1);
  });

  it("stores nothing but a number per plugin id", async () => {
    const live = await env.COUNTER.get(env.COUNTER.idFromName("downloads")).all();
    for (const [id, n] of Object.entries(live)) {
      expect(id).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(Number.isInteger(n)).toBe(true);
    }
  });

  it("serves stats even when no seed exists in the bucket", async () => {
    const fresh = { ...env } as Env;
    const empty = {
      ...fresh,
      ARTIFACTS: {
        get: async (key: string) =>
          key === "stats.json" ? null : env.ARTIFACTS.get(key),
        head: (key: string) => env.ARTIFACTS.head(key),
      } as unknown as R2Bucket,
    };
    const ctx = {
      waitUntil() {},
      passThroughOnException() {},
    } as unknown as ExecutionContext;
    const res = await worker.fetch(new Request(`${BASE}/stats.json`), empty, ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { downloads: Record<string, number> };
    expect(body.downloads["seed-only"]).toBeUndefined();
  });
});

describe("rate limit", () => {
  const ctx = {
    waitUntil() {},
    passThroughOnException() {},
  } as unknown as ExecutionContext;
  const limited: Env = {
    ARTIFACTS: env.ARTIFACTS,
    COUNTER: env.COUNTER,
    LIMITER: env.LIMITER,
    RATE_REQS_PER_MIN: "3",
  };
  const from = (ip: string) =>
    worker.fetch(
      new Request(`${BASE}/index.json`, { headers: { "CF-Connecting-IP": ip } }),
      limited,
      ctx,
    );

  it("answers 429 with Retry-After beyond the per-minute limit, per address", async () => {
    for (let i = 0; i < 3; i++) expect((await from("203.0.113.7")).status).toBe(200);
    const refused = await from("203.0.113.7");
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(refused.headers.get("access-control-allow-origin")).toBe("*");
    expect((await from("203.0.113.8")).status).toBe(200);
  });

  it("the Limiter admits everything when the limit is 0", async () => {
    const limiter = env.LIMITER.get(env.LIMITER.idFromName("unit"));
    for (let i = 0; i < 50; i++) expect((await limiter.admit("c", 0)).ok).toBe(true);
    expect((await limiter.admit("d", 1)).ok).toBe(true);
    expect((await limiter.admit("d", 1)).ok).toBe(false);
  });
});
