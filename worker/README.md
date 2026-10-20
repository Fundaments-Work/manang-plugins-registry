# Manang registry Worker (Cloudflare)

A read-only front for one R2 bucket that holds the built registry (`index.json`,
`index.json.sig`, `stats.json`, `plugins/...`, produced by
`scripts/build-index.mjs`). The Worker never writes the bucket. Full
operating guide: `docs/ops/registry.md`.

## What it serves

| Request                                               | Content-Type      | Cache-Control                         |
| :---------------------------------------------------- | :---------------- | :------------------------------------ |
| `/index.json`, `/index.json.sig`                      | json, text        | `public, max-age=300`                 |
| `/stats.json` (seed merged with live counters)        | json              | `public, max-age=300`                 |
| `/plugins/<id>/README.md`                             | `text/markdown`   | `public, max-age=300`                 |
| `/plugins/<id>/<version>/<id>-<version>.manangplugin` | `application/zip` | `public, max-age=31536000, immutable` |
| `/plugins/<id>/<version>/README.md`                   | `text/markdown`   | `public, max-age=31536000, immutable` |

Everything else is `404`; methods other than GET, HEAD and OPTIONS are `405`.
Every response carries a strong `ETag` (`If-None-Match` gives `304`), supports
single `Range` requests (`206`, `416`, honours `If-Range`), `HEAD`, security
headers (`nosniff`, a `default-src 'none'` CSP, no referrer, HSTS) and CORS for
reading from any origin (`Access-Control-Allow-Origin: *`, no credentials), so
the future web version can fetch the index and artifacts.

## Privacy

`observability` is off and the code never logs. The only thing stored is one
integer per plugin id (a SQLite-backed Durable Object, `Counter`), incremented
when a `.manangplugin` is fetched in full or as a range that starts at byte 0.
HEAD, 304, 416, later ranges, the index and readmes are not counted. No address,
time, version or user agent is kept. The rate limiter (`Limiter`) holds a short
hash of the client address in memory for at most one minute, as the relay does;
`RATE_REQS_PER_MIN` (default 600, `0` = off) in `wrangler.toml`.

## Local run

```sh
pnpm install
pnpm test                 # workerd + in-memory R2, no account needed
pnpm run typecheck

# Serve a local build from the repository root:
pnpm run dev              # http://localhost:8788 (not 1420)
# in another shell, load a built registry into the LOCAL bucket:
cd .. && pnpm run demo    # makes demo-out/dist
cd worker
find ../demo-out/dist -type f | while read -r f; do
  key="${f#../demo-out/dist/}"
  pnpm exec wrangler r2 object put "manang-registry/$key" --file "$f" --local
done
curl -i http://localhost:8788/index.json
```

## Deploy (needs your Cloudflare login; nothing here does it for you)

```sh
pnpm exec wrangler login
pnpm exec wrangler r2 bucket create manang-registry
# upload the build output (see docs/ops/registry.md for the exact loop)
pnpm run deploy           # wrangler deploy
```

`wrangler.toml` has placeholder names and no account id; change `name` and
`bucket_name` if you want others, and attach your domain in the Cloudflare
dashboard (Workers > manang-registry > Settings > Domains & Routes).
