> **Imported on 2026-10-20 and being restructured.** Copied from the Manang repository
> (`docs/plugins-publishing.md`); paths were adjusted for this repository (entries
> live in `plugins/<id>.toml` here), the rest is unchanged. References to the plugin
> author guide now point at `docs/plugin-guide.md` in the `manang-sdk` repository.
> Not yet accurate: the review criteria in section 5 are written for human review
> only, and the registry has no entries yet.

# Publishing a plugin to the Manang registry

For plugin authors. The registry is a reviewed list: you keep your plugin in your
own GitHub repository and publish versions as GitHub releases; a pull request to
this repository lists it. Manang then mirrors each reviewed version,
hashes it, signs the index, and shows the plugin in **Plugins > Browse**.

Building a plugin is covered in `docs/plugin-guide.md` in the `manang-sdk` repository. This page is about getting it
listed. Only sandboxed WASM plugins (`tier = "wasm"`, the default) are listed.

## 1. Prepare the manifest

`manifest.toml` is the single source of truth: the registry reads everything
about your plugin from it, and you never retype it in the registry entry.

```toml
[plugin]
name = "word-count"            # kebab-case; this is the registry id
version = "0.3.1"              # MAJOR.MINOR.PATCH, equals the release tag without "v"
description = "Counts words, characters and lines in the open document."
publisher = "Your Name"        # shown as an unverified claim; defaults to your GitHub owner
license = "MIT"                # an SPDX id or expression (MIT, Apache-2.0, MIT OR Apache-2.0)
homepage = "https://example.org/word-count"   # optional

[permissions]                  # ask for the least you need, and say why in your README
buffer = ["read:active"]
```

Notes:

- `license` is optional if your GitHub repository has a detected licence; the
  registry then uses that. Set it explicitly: a clear licence is a review
  requirement.
- The index lists your **permissions exactly as declared**. Users see them
  before they install and again, with a new consent, if an update asks for more.
- `name` must match the file name of your registry entry and never change after
  you are listed.

## 2. Build the `.manangplugin`

A `.manangplugin` is a zip of the plugin folder: `manifest.toml`, `plugin.wasm`
and optionally `README.md`, `LICENSE` and an `assets/` folder (files at the root,
or all inside one folder). Nothing else is accepted. Build the wasm component as
in `docs/plugin-guide.md` of the `manang-sdk` repository (`scripts/build-plugin.sh` there), then:

```sh
cd out/word-count
zip -r ../word-count-0.3.1.manangplugin manifest.toml plugin.wasm README.md LICENSE assets
```

Limits: at most 20 MiB for the archive, 256 files; no hidden files, no symlinks,
no paths with `..`. The registry rejects anything the app's installer would.

## 3. Create a GitHub release

Tag `v<version>` (for example `v0.3.1`) and attach the `.manangplugin` as a
release asset. Put the changelog in the release notes: the first 4,000
characters are shown to users as "What's new". Do not mark it as a pre-release
or draft (those are ignored). One matching asset per release.

## 4. Open a pull request

Add `plugins/<id>.toml` to this repository, where `<id>` is your
manifest's `name`:

```toml
id = "word-count"
repo = "https://github.com/you/manang-word-count"
tags = ["writing", "statistics"]          # 1 to 8 lowercase tags
release_asset_pattern = "word-count-*.manangplugin"   # `*` matches any run of characters
readme = "README.md"                      # optional: file inside the archive; default: the first README*
```

CI validates the entry in a minute: shape, id equals file name and manifest name,
the release asset downloads, is a well-formed `.manangplugin` with a valid
`wasm` manifest, is under the size cap, has an SPDX licence, and lists the
capabilities it asks for. Fix what it reports and push again. You can run the
same check locally: `pnpm install && pnpm run validate`.

## 5. What reviewers check

- A valid manifest.
- Capabilities are minimal and explained (in the README or the PR).
- Open source with a licence.
- No obfuscated code.
- It builds from the linked source.
- No network host that is not declared.

Plugins run in the Wasmtime sandbox with only their declared capabilities, so the
review is about honesty and quality rather than the safety of the host. A
reviewer may ask you to narrow a permission or document one.

## 6. Versioning, updates and deprecation

- **New version.** Bump `version` in `manifest.toml`, build, create the release
  `v<new version>`. You do **not** open another PR: the registry picks up new
  releases when it is rebuilt and lists your newest ten. Only changes to the entry
  itself (tags, asset pattern) need a PR.
- **Versions are immutable.** Once a version is published, the registry mirrors
  it and records its sha256. If you re-upload a different file under the same
  version, the build fails. Cut a new version instead.
- **Updates.** Users with the plugin installed see **Update** on the Plugins
  page when `latest` is newer than theirs. If the new version asks for any
  permission the old one did not, the user must approve it again before it runs;
  the old version keeps working until then. Nothing updates without a click.
- **Semantic versions.** Use `MAJOR.MINOR.PATCH`; pre-release tags are not
  listed. Raise the minor version when you add a permission.
- **Deprecation and removal.** To retire a plugin, say so in your README and the
  last release's notes, then open a PR deleting `plugins/<id>.toml`.
  It disappears from Browse and no longer offers updates. Copies users already
  installed keep working. A single broken release can be hidden by a maintainer
  (`yanked = ["x.y.z"]` in your entry): publish a fixed version.

## 7. What users see

On **Plugins > Browse** your plugin appears with its name, description, author,
latest version, size, licence and tags; the detail page adds your README, the
changelog, a link to your repository and, most prominently, **what it is allowed
to do** (the permissions from your manifest in plain words). Installing asks
them to approve exactly those capabilities. Downloads come from Manang's mirror,
checked against the signed hash; they never run code from your repository.

Download counts are a counter per plugin on the registry host. No address or
user data is stored.
