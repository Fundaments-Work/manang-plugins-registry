# manang-plugins-registry

The list of plugins that Manang can install from **Plugins > Browse**, plus the
tooling that turns that list into a signed index. A plugin lives in its author's own
GitHub repository and publishes versions as GitHub releases; this repository holds
one small TOML entry per plugin, the review guidelines, and the scripts that
validate entries and build and sign `index.json`. The app verifies the signature
before it shows or installs anything.

## Status

**Pre-release. There are no entries yet** (`plugins/` is empty, the two files in
`samples/plugins/` point at offline test fixtures, not real repositories). The
content was imported from the Manang repository on 2026-10-20; the old copy there
stays authoritative until the checks here are green. The signing secret
`REGISTRY_SIGNING_KEY` is not set in this repository, so the workflow's build job
cannot sign anything yet, and the repository is private until launch.

## How an author submits

1. Write and build your plugin (see the author guide in the `manang-sdk` repository,
   `docs/plugin-guide.md`) and publish a GitHub release `vMAJOR.MINOR.PATCH` with a
   `.manangplugin` asset attached.
2. Copy `samples/plugins/word-count.toml` to `plugins/<id>.toml` and point `repo` at
   your repository.
3. Run `pnpm install` and `pnpm run validate` (it downloads your release asset).
4. Open a pull request. The steps in detail, and what reviewers check, are in
   [docs/publishing.md](docs/publishing.md); see also [CONTRIBUTING.md](CONTRIBUTING.md).

Operators: [docs/ops/registry.md](docs/ops/registry.md).

## Layout

```
plugins/<id>.toml     the entries (reviewed by pull request)
samples/plugins/      two sample entries that run offline against fixtures
schema/               JSON Schemas (entry, index, stats) and types.ts
scripts/              validate, build-index, keygen, verify-index, demo
test/                 offline tests (node:test); test/fixtures/ holds vendored inputs
worker/               the Cloudflare Worker + R2 that serves it all
docs/                 publishing guide (authors) and operations guide
```

## Related repositories

All under the `Fundaments-Work` organisation, all private for now.

* `Manang`: the application (it embeds the registry's public key)
* `manang-sdk`: the plugin interface, the componentize tool, the example and the guide
* `manang-plugin-template`: a starter repository for a new plugin
* `manang-plugins-registry`: this repository

## Licence

MIT, see `LICENSE`.

---

The rest of this file is the tooling reference, imported from the Manang
repository's `registry/README.md` (Fundaments-Work/Manang at
488c080). Paths in it that name Manang source files refer to the app repository.

## Commands (run at the repository root, Node 22, pnpm)

| Command                                              | What it does                                               |
| :--------------------------------------------------- | :--------------------------------------------------------- |
| `pnpm install`                                       | Installs the pinned dependencies                           |
| `pnpm test`                                          | Offline tests, no network                                  |
| `pnpm run typecheck`                                 | Type checks `schema/types.ts`                              |
| `pnpm run demo`                                      | Whole pipeline offline on the samples, throwaway key       |
| `pnpm run validate`                                  | Validates `plugins/*.toml` (downloads real release assets) |
| `pnpm run keygen --private-out <path>`               | New signing keypair, public key printed                    |
| `REGISTRY_SIGNING_KEY=... pnpm run build --out dist` | Builds and signs `dist/`                                   |
| `pnpm run verify dist <public key>`                  | Checks signature, schema, sizes and hashes of a build      |

(`validate`, `build` and the others accept `--entries <dir>` and `--fixtures <dir>`;
see the header of each script.)

## What the scripts check

`validate.mjs` and `build-index.mjs` share one resolver. For each entry it lists
the GitHub releases (non-draft, non-prerelease, tag `vMAJOR.MINOR.PATCH`, newest
ten), picks the asset matching `release_asset_pattern`, downloads it and checks:

- the entry: shape per `schema/entry.schema.json`, `id` is kebab-case and equals
  the file name, no duplicate ids or repositories;
- the asset exists, is at most 20 MiB and is exactly one per release;
- it is a well-formed `.manangplugin` by the same rules as
  `crates/manang-plugins/src/archive.rs` (in the Manang repository) (safe paths, only `manifest.toml`,
  `plugin.wasm`, README, LICENSE and `assets/`, at most 256 files, no symlinks,
  wasm magic bytes);
- `manifest.toml` parses, `[plugin] name` equals the entry id, `version` equals
  the release tag, `tier` is `wasm`, and every `[permissions]` entry parses with
  the app's capability rules (the capabilities are listed in the output);
- the licence is an SPDX expression (from `[plugin] license`, else the GitHub
  repository's licence);
- with `--previous <published index.json>`: a version that was already published
  must still have the same size and sha256.

A release that is not the newest and fails is skipped with a warning (so an old
bad release cannot block the registry forever); the newest one failing is an
error. Errors are all collected and printed together.

## Offline runs and fixtures

`--fixtures <dir>` replaces the GitHub API with a directory:

```
<dir>/<owner>/<repo>/releases.json   the GitHub "list releases" response
<dir>/<owner>/<repo>/repo.json       { "license": { "spdx_id": "MIT" }, "homepage": "" }
<dir>/<owner>/<repo>/assets/<name>   the asset bytes
```

`scripts/lib/fixtures.mjs` builds valid and deliberately broken archives for the
tests (the wasm inside is an 8-byte stub, never meant to run).

## Replacing the samples with real plugins

The two entries in `samples/plugins/` point at fixtures, not real repositories.
To list a real plugin: copy a sample to `plugins/<id>.toml`, set `repo` to the
author's repository (it must have a GitHub release with a `.manangplugin` asset
whose manifest name equals `<id>`), then run `pnpm run validate`. Once
`plugins/` has real entries, delete `samples/` or keep it for the tests (the
tests read it).

## Key and signature formats

| Thing            | Format                                                                               |
| :--------------- | :----------------------------------------------------------------------------------- |
| Private key      | base64 of the 32-byte ed25519 seed (the secret `REGISTRY_SIGNING_KEY`)               |
| Public key       | base64 of the raw 32-byte key (what the app embeds)                                  |
| `index.json.sig` | base64 of the 64-byte signature over the exact bytes of `index.json`, plus a newline |

The signature covers the file bytes as written (two-space JSON, trailing
newline); clients must verify the bytes they fetched, before parsing.
