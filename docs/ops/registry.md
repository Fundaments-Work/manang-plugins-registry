> **Imported on 2026-10-20 and being restructured.** Copied from the Manang repository
> (`docs/ops/registry.md`); paths were adjusted for this repository (the registry is
> at the repository root, not in `registry/`). The hostname, the signing secret and the
> key rotation steps are not set up in this repository yet.

# Running the plugin registry

For the lead. The registry is a signed `index.json` plus mirrored plugin
archives, served by a Cloudflare Worker from an R2 bucket. The app embeds the
registry's **public key** and trusts nothing else. Design:
`docs/plans/2026-10-19-plugin-marketplace.md` (in the Manang repository). Code: this repository. Authors'
side: `docs/publishing.md`.

## How the pieces fit

| Piece                  | Where                                         | Trusted?                                                        |
| :--------------------- | :-------------------------------------------- | :-------------------------------------------------------------- |
| Public key             | embedded in the app (a list, several allowed) | **Yes. The only trust root.**                                   |
| Private key            | CI secret `REGISTRY_SIGNING_KEY`, plus one offline copy | Never leaves CI and your password manager             |
| Entries                | `plugins/<id>.toml`, merged by PR    | Reviewed by a person                                            |
| `index.json` + `.sig`  | R2 bucket, served by the Worker               | Only if the signature verifies                                  |
| Artifacts              | R2, `plugins/<id>/<version>/...`              | Only if size and sha256 equal the signed index                  |
| Host / base URL        | `MANANG_REGISTRY_URL` build constant          | No. It only says where to fetch from.                           |

A compromised host or bucket can withhold or replay old files. It cannot make the
app install something the signing key did not sign.

## 1. Generate the signing key (once)

```sh
pnpm install
mkdir -p ~/secrets && chmod 700 ~/secrets          # anywhere outside the repository
pnpm run keygen --private-out ~/secrets/manang-registry.key
```

It prints the **public key** (base64, 32 bytes) and writes the private key
(base64 seed) only to that path, mode 0600; it refuses a path inside the
repository or one that exists. Then:

1. Store the private key as the repository secret `REGISTRY_SIGNING_KEY`:
   `gh secret set REGISTRY_SIGNING_KEY < ~/secrets/manang-registry.key`.
2. Keep one offline copy (password manager). Without it you cannot sign.
3. Give the public key to the app (the client's embedded key list; it accepts
   several keys so rotation works, see below).

## 2. Build and sign

On demand in CI: Actions > **Registry** > Run workflow (optionally paste the live
registry URL so the build refuses any change to an already published version).
Download the artifact `registry-dist`. Or locally, with the key in the
environment, never on a command line you keep in history:

```sh
cd registry
curl -fsS "$REGISTRY_URL/index.json" -o previous-index.json   # optional, after the first publish
REGISTRY_SIGNING_KEY="$(cat ~/secrets/manang-registry.key)" \
  pnpm run build --out dist --previous previous-index.json
pnpm run verify dist <public key>
```

(`--previous` is the currently published `index.json`. Put it anywhere you like;
the build only reads it.) The build resolves every entry, downloads and checks
each asset, writes `dist/index.json`, `index.json.sig`, `stats.json` and
`dist/plugins/<id>/<version>/<id>-<version>.manangplugin` (+ readmes), then
verifies its own signature. Any error stops it before anything is written.
`verify` re-checks signature, schema, sizes and hashes of the folder, which is
what you upload.

## 3. Create the bucket and upload

```sh
cd worker
pnpm install
pnpm exec wrangler login
pnpm exec wrangler r2 bucket create manang-registry
```

Upload **artifacts first, the index last**, so the index never points at a file
that is not there yet. `stats.json` is only a seed of starting counts: upload it
once (the Worker adds its live counters on top) and do not overwrite it later.

```sh
cd registry
B=manang-registry
put() { (cd worker && pnpm exec wrangler r2 object put "$B/$1" --file "../dist/$1" --remote); }
# 1. every artifact and readme (immutable; existing keys may be skipped)
(cd dist && find plugins -type f) | while read -r key; do put "$key"; done
# 2. the seed, first publish only
put stats.json
# 3. the index and its signature
put index.json.sig
put index.json
```

Between the last two uploads a client can fetch a new index with the old signature
and rejects it; it keeps its cached list and tries again later (the index is
cached for five minutes). Upload the two back to back.

Artifacts are immutable by design: never re-upload a different file under an
existing `<id>/<version>` key.

## 4. Deploy the Worker

```sh
cd worker
pnpm run test && pnpm run typecheck
pnpm run deploy            # wrangler deploy
```

Then attach a domain: Cloudflare dashboard > Workers > `manang-registry` >
Settings > Domains & Routes (or `routes` in `wrangler.toml`). Set that origin as
`MANANG_REGISTRY_URL` in the app build. Check:

```sh
curl -i https://<host>/index.json
curl -i -H "Range: bytes=0-99" https://<host>/plugins/<id>/<version>/<id>-<version>.manangplugin
curl -s https://<host>/stats.json
```

The Worker needs no secrets. `observability` is off. The free plan is enough to
start (Workers requests, R2 free tier, SQLite Durable Objects); watch R2 storage
and Class B reads (every download is a HEAD plus a GET).

## 5. Routine publishing (after the first time)

1. A plugin PR merges (CI validated it; a maintainer reviewed the criteria).
2. Run **Registry** > Run workflow; download `registry-dist`; `pnpm run verify`.
3. Upload (step 3) and you are done. No Worker redeploy is needed for content
   changes.

## 6. Rotating the signing key

Rotate on a schedule you can keep (yearly) and always after any suspicion.

1. `pnpm run keygen --private-out ~/secrets/manang-registry-2.key`.
2. Ship an app release that embeds **both** public keys (the app accepts a
   signature from any key in its list). Wait until most users have it.
3. Switch CI: `gh secret set REGISTRY_SIGNING_KEY < ~/secrets/manang-registry-2.key`,
   rebuild and re-upload the index and signature.
4. In a later app release, drop the old public key. Destroy the old private key.

Users on an app version that only knows the old key stop accepting new indexes
once step 3 happens (they keep their cache and see a notice), so step 2 must
reach them first.

## 7. Taking something down

**One version** (a bad release, a licence problem): add it to the entry's
`yanked` list and open a PR.

```toml
# plugins/<id>.toml
yanked = ["0.3.1"]
```

Rebuild and upload the index (the version is gone from it, `latest` falls back to
the previous one), then delete the mirrored files so the URL stops working:

```sh
cd worker
pnpm exec wrangler r2 object delete manang-registry/plugins/<id>/0.3.1/<id>-0.3.1.manangplugin --remote
pnpm exec wrangler r2 object delete manang-registry/plugins/<id>/0.3.1/README.md --remote
```

**A whole plugin**: delete `plugins/<id>.toml` (PR), rebuild and upload
the index, then delete its objects. R2 has no list command in `wrangler`; take the
keys from the _previous_ index:

```sh
curl -s https://<host>/index.json \
  | node -e 'const i=JSON.parse(require("fs").readFileSync(0,"utf8"));for(const p of i.plugins.filter(p=>p.id==="<id>"))for(const v of p.versions)console.log(v.download)' \
  | while read -r key; do (cd worker && pnpm exec wrangler r2 object delete "manang-registry/$key" --remote); done
```

(plus `plugins/<id>/README.md` and the per-version `README.md` files.)

Limits to know: removing a plugin from the index stops new installs and update
offers. It does not remove copies users already installed, and the app has no
revocation list yet. For a malicious plugin that is a gap; see "Follow-ups".

## 8. If the signing key leaks

The key alone does not let anyone serve users anything: an attacker also needs
write access to the bucket or the domain, because the app fetches from your host.
But treat it as serious, since the key is the root of trust.

1. **Stop publishing.** Disable the workflow, delete the secret
   (`gh secret delete REGISTRY_SIGNING_KEY`), and rotate the Cloudflare API tokens
   and R2 credentials that could write the bucket.
2. **Inspect the bucket**: compare `index.json` and every object's sha256 with the
   last build you made (keep each `registry-dist` artifact; they last 14 days, so
   archive the release builds). Restore from your last known-good build.
3. **Generate a new key** (step 6.1) and **ship an app release** that embeds only
   the new public key (not both: the old one is compromised). This is the real
   fix, because the old key is baked into every installed app.
4. Until that release is out, an attacker who holds both the key and your hosting
   could serve a signed index. If you suspect that, point `MANANG_REGISTRY_URL` at
   a new host in the release and take the old Worker down.
5. After the release, re-sign and publish; tell users in the release notes.

## Follow-ups worth doing

- An app-side **revocation list** (signed, small) so a takedown can also disable
  an installed plugin, and a key-revocation list so a leaked key can be retired
  without an app release.
- `[plugin] license` and `homepage` in the plugin manifest (the registry reads
  them when present and otherwise falls back to the GitHub repository's licence
  and homepage).
- Archive release builds of the index outside GitHub's 14 day artifact retention.
