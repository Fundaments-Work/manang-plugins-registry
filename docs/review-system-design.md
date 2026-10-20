# Review system design (proposed)

Status: **proposed**, 2026-10-20. Nothing in this document is implemented yet: today the registry's
validator checks the entry, the archive layout, the manifest, the tag, the licence string and permission
syntax, and it never looks inside `plugin.wasm`. This page describes the review system we intend to build:
rules authors run locally and in CI, an automated scan of every version that fails closed, and tests that
prove the automation works. [V] verified in a primary source or in the repository, [I] inferred.

## What we copy and what we avoid

* Obsidian [V]: every version of every plugin gets an automated scan (policy, code quality, vulnerabilities,
  malware) that usually finishes in minutes; humans review popular, featured and flagged plugins; authors
  run the same checks locally (`eslint-plugin-obsidianmd`, 41 rules; the lint is advisory, the scan is the
  gate). A failed update delisted the whole plugin, which authors criticised.
* So: block only the new version and keep the last good one, show the report in the CLI and in the pull
  request, and announce grace periods in advance.
* Open VSX "Open Sesame" [V]: one boolean meant both "no scanner configured" and "all enqueues failed", so
  under load a scan was skipped and the extension passed. So: the scan record is a three-state value
  (`pass`, `reject`, `error`), `error` counts as `reject`, and the index builder refuses any version without a
  stored `pass` record.

## Rule catalog (severity E blocks, W advises)

Prefixes: M manifest, A archive, W wasm component, B behaviour (smoke run), P policy, S source, R registry.

| Id | Sev | What it checks |
| :--- | :--- | :--- |
| M001 | E | `manifest.toml` parses with the app's own manifest parser (no drift), at most 64 KiB, unknown permission keys denied |
| M002 | E | Required fields (name, version, description, licence, publisher); no control or bidi characters |
| M003 | E | Name is kebab-case, 3-40 characters, matches the entry and archive; no first-party or reserved names |
| M004 | E | Impersonation: edit distance or homoglyph match against existing ids and first-party names, unless the same owner |
| M005 | E | Version equals the release tag and is greater than every published version |
| M006 | E | `api` is supported by the current or previous host line (absent: W until a published date) |
| M007 | E | Licence is an SPDX expression on the allow-list |
| M008-M009 | E | Tier is `wasm`; command ids are `<name>.<local>`, unique, titled; hooks are valid |
| M010 | W | Command title embeds the plugin name or the word "command"; default key bindings; not sentence case |
| M011 | E | Settings are namespaced, typed, described, with a valid default |
| M012 | E | Network hosts are exact lowercase DNS names: no wildcard, scheme, IP literal, `localhost` or `.local` |
| M013 | E/W | Filesystem scopes are safe relative paths; write at the project root is E, broad read is W |
| M015 | W | Placeholder names and template text left in |
| A001 | E | Archive layout and limits: 256 files, 20 MiB, no symlinks, hidden files, duplicates or zip bombs |
| A002 | E | README and LICENSE present and not the template text |
| A003 | E | The Rust and Node archive validators agree on a shared vector set |
| W001-W003 | E | A real component (preamble), validated with the host's feature set and caps, exporting exactly `manang:plugin/handler@0.2.0` and importing only the `manang:plugin` interfaces |
| W004 | E | No `wasi:*` imports and no unknown imports |
| W005 | E | An import without the matching declared permission (mirrors the host's `UngrantedImport`) |
| W006 | W | A declared permission with no matching import (over-asking), per interface |
| W007 | E | Size and memory within host limits |
| W008 | W/E | Anomalies: high-entropy data segments, unexpected custom sections, embedded executables (E if a nested executable) |
| B001-B003 | E | Smoke run in the real host with the real limits: instantiate; call every declared command and hook with empty, malformed and 16 MiB payloads; no trap, no deadline hit, bounded output; undeclared commands fail; side effects only within the declaration (recording fake host) |
| B004-B005 | W | Determinism across fresh stores; time and memory budgets on empty input |
| B006 | E | Panic and trap messages are bounded and carry no host paths |
| P001-P002 | E | README discloses network use (each declared host and what is sent) and write permissions |
| P003-P005 | E | No client-side telemetry (analytics blocklist), no active HTML or data URIs, no ads, payments or accounts without a README statement |
| P006 | E | Source is open and linked (decision D1) |
| P007 | label | First submission, new capability, new host or wider scope: routes to a human |
| R001-R003 | E/W | Public repo, tag exists, release asset hash matches, proof of repository ownership, immutability of published versions, idle-id release |
| S001-S004 | E/W | Author-side: clippy preset (no unwrap, expect, panic), `cargo deny`, reproducible-build evidence, no unsafe, no build-time network |

Not statically checkable: which commands a plugin implements (every world exports the same generic
`invoke` and `on-hook`), so that is a behaviour check (B002), not a manifest-versus-exports check.
Obsidian rules about DOM, workspace and mobile hygiene have no equivalent, because plugins here have no
DOM or Node access; the W, B, M004, M012, M013 and A001 rules are new for WebAssembly.

## Pipeline

1. **Authors:** `cargo manang validate [--tag vX.Y.Z | --archive file] [--format human|json|sarif]` runs the
   exact same engine locally. Registry-dependent checks (M004, R*) run only with `--registry <index>`; when
   skipped they are listed as "not checked", never as passed.
2. **Pull requests** in this repo run the engine with the live index and post a summary plus SARIF.
3. **Every new version** is scanned at publish time; the stored record holds the engine and ruleset versions,
   the input hash and the report hash; a crash, timeout or missing result means not listed.
4. **Re-scan** of every published version whenever the ruleset or engine changes. A new E on a published
   version opens an issue and starts a grace period; malware-class findings revoke at once.
5. **Humans** only on triggers: first submission, a new or widened capability, impersonation near-misses,
   appeals, popularity, large rule changes, repeat violators. They see the report, the permission diff and the
   README, not the wasm.
6. **Rule rollout:** a new rule ships as W for 30 days, with the promotion date published, then becomes E; the
   replay count over published versions is published before promotion.
7. **Revocation:** a scan can mark a version revoked in a signed `revocations.json`. That list and the client
   check are NOT built; until they are, a revocation stops only new installs and the developer policy says so.

## The validator's own security

It parses hostile input: size caps, bounded `wasmparser` use, a CPU watchdog, address-space limits; the smoke
run executes in a child process with no network, a read-only root and a timeout; plugin code runs only inside
Wasmtime through the host crate's code path, never through a system tool or a build step on author source;
`wasmparser`, `wit-component` and `wasmtime` are pinned to the exact versions in the app's lock file, with a
test comparing the two; fuzz targets cover manifest validation, archive reading, component inspection and
smoke payloads (60 seconds each).

## Proof the automation works

* A corpus: good fixtures (one per world) and one deliberately bad archive per rule id; each bad fixture must
  fail with exactly its rule; a rule without a fixture, or a fixture without a rule, fails a coverage test.
* Golden snapshots of the JSON report and the human summary.
* Seeded mutation tests on the good plugin (flip a preamble byte, add an undeclared import, add an unused
  permission, change the version, add a `wasi` import, add a wildcard host, widen a scope): the specific rule
  must fire and nothing may pass silently.
* A differential test against the real host: the CLI says pass implies the host loads; the host rejects
  implies the CLI has an E; the only asymmetry is the policy and registry rules the host does not run.
* A permanent negative canary in registry CI: `canary-bad` must be rejected and `canary-good` accepted, plus a
  deliberate scanner-error case that must be a rejection; the job fails if the bad one passes. A weekly run
  proves the live pipeline.
* Workflow tests (`actionlint`, dry runs, third-party actions pinned by commit, path filters, concurrency
  cancel, timeouts), a regression fixture for every bug, performance budgets (static rules under 100 ms, smoke
  under 3 s, validator under 256 MiB, pull-request job under 5 minutes), and false-positive tracking (a rule
  with more than 5% overturned appeals over 20 or more hits is demoted to W).
* Honest limit: this proves the rules fire and the pipeline fails closed. It does not prove a malicious plugin
  is detected; the sandbox and the capability model do that.

## Work packages

R0 decision record and `rules/catalog.toml`; R1 manifest `license`, `homepage`, `api` fields and the M rules
as a small pure crate; R2 one archive engine with shared vectors; R3 W rules (heavy build); R4 B rules and
the smoke harness (heavy); R5 report formats, `cargo manang validate`, corpus; R6 registry integration with the
three-state scan record, canary, ownership claim and permission diff; R7 fuzzing, differential test,
benchmarks (heavy, alone); R8 policy and source rules and the author Action; R9 revocation (heavy); R10
nightly re-scan and rule promotion; R11 documentation generated from the catalog. Heavy packages run one at a
time. Revocation (R9) must ship before any public launch of the marketplace.

## Decisions for the owner (recommended defaults)

* D1 closed source: open source required at launch.
* D2 licence allow-list: MIT, Apache-2.0, BSD-2/3, ISC, 0BSD, MPL-2.0, Unlicense, CC0-1.0, Zlib; copyleft by a
  human decision.
* D3 review time: automated in minutes; human 7 days; auto-close after 14 days of silence; 14-day grace for a
  new E on a published version.
* D4 strictness at launch: W for S003, W006, B004, B005, W008, M010, M014, S004; everything else E.
* D5 reputation: two revoked versions in 90 days sends a publisher's versions to human review for 90 days.
* D6 the registry hostname and a security and takedown contact address.
