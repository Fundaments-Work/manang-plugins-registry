import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveAll } from "../scripts/lib/build.mjs";
import { loadEntries } from "../scripts/lib/entries.mjs";
import {
  WASM_STUB,
  makeArchive,
  manifestText,
  validPlugin,
  writeFixtureRepo,
} from "../scripts/lib/fixtures.mjs";
import { resolveEntry } from "../scripts/lib/resolve.mjs";
import { fixtureSource } from "../scripts/lib/sources.mjs";
import { scenario, tempDir, writeEntry } from "./helpers.mjs";
import path from "node:path";
import { mkdir } from "node:fs/promises";

async function run(opts) {
  const s = await scenario(opts);
  const r = await resolveAll({
    entriesDir: s.entriesDir,
    source: fixtureSource(s.fixtures),
  });
  return { ...r, ...s };
}

function release(id, bytes, over = {}) {
  return { tag: "v1.0.0", assetName: `${id}-1.0.0.manangplugin`, bytes, ...over };
}

function expectError(r, pattern) {
  assert.ok(
    r.errors.some((e) => pattern.test(e)),
    `expected an error matching ${pattern}, got: ${JSON.stringify(r.errors)}`,
  );
  assert.equal(r.results.length, 0);
}

test("a valid plugin passes and its capabilities are listed", async () => {
  const id = "demo-plugin";
  const r = await run({
    releases: [
      release(
        id,
        validPlugin({
          name: id,
          permissions:
            '[permissions]\nnetwork = ["api.example.org"]\nbuffer = ["read:active"]',
        }),
      ),
    ],
  });
  assert.deepEqual(r.errors, []);
  const [{ plugin }] = r.results;
  assert.equal(plugin.latest, "1.0.0");
  assert.deepEqual(plugin.versions[0].permissions, {
    network: ["api.example.org"],
    buffer: ["read:active"],
  });
  assert.equal(plugin.license, "MIT");
});

test("archives with everything inside one folder are accepted", async () => {
  const id = "demo-plugin";
  const bytes = makeArchive(
    { "manifest.toml": manifestText({ name: id }), "plugin.wasm": WASM_STUB },
    { folder: id },
  );
  const r = await run({ releases: [release(id, bytes)] });
  assert.deepEqual(r.errors, []);
});

test("manifest name must equal the entry id", async () => {
  const r = await run({
    releases: [release("demo-plugin", validPlugin({ name: "other-name" }))],
  });
  expectError(
    r,
    /manifest plugin name `other-name` must equal the entry id `demo-plugin`/,
  );
});

test("manifest version must equal the release tag", async () => {
  const r = await run({
    releases: [
      release("demo-plugin", validPlugin({ name: "demo-plugin", version: "1.0.1" })),
    ],
  });
  expectError(r, /does not match the release tag v1\.0\.0/);
});

test("native-tier plugins are refused", async () => {
  const r = await run({
    releases: [
      release(
        "demo-plugin",
        validPlugin({ name: "demo-plugin", extra: 'tier = "native"' }),
      ),
    ],
  });
  expectError(r, /only sandboxed `wasm` plugins are listed/);
});

test("an asset over the size cap is refused, by its declared and its real size", async () => {
  const id = "demo-plugin";
  const bytes = validPlugin({ name: id });
  const declared = await scenario({
    releases: [release(id, bytes, { declaredSize: 21 * 1024 * 1024 })],
  });
  await assert.rejects(
    resolveEntry(
      {
        id,
        repo: `https://github.com/acme/manang-${id}`,
        tags: ["x"],
        release_asset_pattern: "*.manangplugin",
      },
      fixtureSource(declared.fixtures),
    ),
    /the limit is 20971520/,
  );
  const real = await scenario({ releases: [release(id, bytes)] });
  await assert.rejects(
    resolveEntry(
      {
        id,
        repo: `https://github.com/acme/manang-${id}`,
        tags: ["x"],
        release_asset_pattern: "*.manangplugin",
      },
      fixtureSource(real.fixtures),
      { maxBytes: 100 },
    ),
    /the limit is 100/,
  );
});

test("a missing release asset (download 404) is reported", async () => {
  const id = "demo-plugin";
  const s = await scenario();
  // Point the release list at an asset that was never uploaded.
  await writeFixtureRepo(s.fixtures, {
    owner: "acme",
    repo: `manang-${id}`,
    releases: [release(id, validPlugin({ name: id }))],
  });
  const { rm } = await import("node:fs/promises");
  await rm(
    path.join(s.fixtures, "acme", `manang-${id}`, "assets", `${id}-1.0.0.manangplugin`),
  );
  const r = await resolveAll({
    entriesDir: s.entriesDir,
    source: fixtureSource(s.fixtures),
  });
  expectError(r, /does not exist \(404\)/);
});

test("no release with a matching asset is an error", async () => {
  const r = await run({ entry: { release_asset_pattern: "nothing-*.manangplugin" } });
  expectError(r, /no release of .* has an asset matching/);
});

test("two assets matching the pattern are ambiguous", async () => {
  const id = "demo-plugin";
  const s = await scenario();
  const base = path.join(s.fixtures, "acme", `manang-${id}`);
  const { writeFile, readFile } = await import("node:fs/promises");
  const releases = JSON.parse(await readFile(path.join(base, "releases.json"), "utf8"));
  releases[0].assets.push({ ...releases[0].assets[0], name: "other.manangplugin" });
  await writeFile(path.join(base, "releases.json"), JSON.stringify(releases));
  const r = await resolveAll({
    entriesDir: s.entriesDir,
    source: fixtureSource(s.fixtures),
  });
  expectError(r, /2 assets matching the pattern/);
});

test("malformed archives are refused with a reason", async () => {
  const id = "demo-plugin";
  const good = {
    "manifest.toml": manifestText({ name: id }),
    "plugin.wasm": WASM_STUB,
  };
  const cases = [
    [
      "not a zip",
      new TextEncoder().encode("hello, this is not a zip file at all"),
      /not a zip/,
    ],
    ["truncated zip", validPlugin({ name: id }).slice(0, 60), /not a zip/],
    ["no manifest", makeArchive({ "plugin.wasm": WASM_STUB }), /no `manifest.toml`/],
    [
      "no wasm",
      makeArchive({ "manifest.toml": manifestText({ name: id }) }),
      /no `plugin.wasm`/,
    ],
    [
      "bad wasm magic",
      makeArchive({ ...good, "plugin.wasm": new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]) }),
      /bad magic/,
    ],
    [
      "unexpected file",
      makeArchive({ ...good, "run.sh": "echo hi" }),
      /not allowed in a plugin/,
    ],
    [
      "path traversal",
      makeArchive({ ...good, "../evil.txt": "x" }),
      /not a safe relative path/,
    ],
    [
      "absolute path",
      makeArchive({ ...good, "/etc/passwd": "x" }),
      /not a safe relative path/,
    ],
    [
      "hidden file",
      makeArchive({ ...good, "assets/.secret": "x" }),
      /not a safe relative path/,
    ],
    [
      "symbolic link",
      makeArchive({ ...good, "assets/link": { symlink: "/etc/passwd" } }),
      /symbolic link/,
    ],
    [
      "bad TOML",
      makeArchive({ ...good, "manifest.toml": "[plugin\nname =" }),
      /not valid TOML/,
    ],
    [
      "wildcard host",
      makeArchive({
        ...good,
        "manifest.toml": manifestText({
          name: id,
          permissions: '[permissions]\nnetwork = ["*.example.org"]',
        }),
      }),
      /not a plain host name/,
    ],
    [
      "escaping fs scope",
      makeArchive({
        ...good,
        "manifest.toml": manifestText({
          name: id,
          permissions: '[permissions]\nfilesystem = ["read:../x"]',
        }),
      }),
      /relative path without \.\./,
    ],
    [
      "unknown permission kind",
      makeArchive({
        ...good,
        "manifest.toml": manifestText({
          name: id,
          permissions: '[permissions]\nsyscalls = ["all"]',
        }),
      }),
      /unknown permission kind/,
    ],
    [
      "non-semver version",
      makeArchive({
        ...good,
        "manifest.toml": manifestText({ name: id, version: "1.0" }),
      }),
      /must be MAJOR\.MINOR\.PATCH/,
    ],
    [
      "too many files",
      makeArchive({
        ...good,
        ...Object.fromEntries(
          Array.from({ length: 300 }, (_, i) => [`assets/f${i}.txt`, "x"]),
        ),
      }),
      /more than 256 files/,
    ],
  ];
  for (const [label, bytes, pattern] of cases) {
    const r = await run({ releases: [release(id, bytes)] });
    assert.ok(
      r.errors.some((e) => pattern.test(e)),
      `${label}: expected ${pattern}, got ${JSON.stringify(r.errors)}`,
    );
  }
});

test("licences must be SPDX identifiers", async () => {
  const id = "demo-plugin";
  const bad = await run({
    releases: [
      release(id, validPlugin({ name: id, extra: 'license = "Totally Free"' })),
    ],
  });
  expectError(bad, /not a valid SPDX expression/);
  const ok = await run({
    releases: [
      release(id, validPlugin({ name: id, extra: 'license = "MIT OR Apache-2.0"' })),
    ],
  });
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.results[0].plugin.license, "MIT OR Apache-2.0");
  const none = await run({ license: null });
  expectError(none, /no licence found/);
});

test("entry shape: unknown fields, bad ids, bad repo, missing tags", async () => {
  const root = await tempDir();
  const dir = path.join(root, "plugins");
  await mkdir(dir);
  const base = {
    repo: "https://github.com/a/b",
    tags: ["x"],
    release_asset_pattern: "*.manangplugin",
  };
  await writeEntry(dir, "good-one.toml", { id: "good-one", ...base, surprise: 1 });
  await writeEntry(dir, "Bad_Id.toml", { id: "Bad_Id", ...base });
  await writeEntry(dir, "gitlab.toml", {
    id: "gitlab",
    ...base,
    repo: "https://gitlab.com/a/b",
  });
  await writeEntry(dir, "no-tags.toml", { id: "no-tags", ...base, tags: [] });
  await writeEntry(dir, "bad-pattern.toml", {
    id: "bad-pattern",
    ...base,
    release_asset_pattern: "../x.zip",
  });
  const { errors } = await loadEntries(dir);
  for (const needle of [
    "good-one.toml",
    "Bad_Id.toml",
    "gitlab.toml",
    "no-tags.toml",
    "bad-pattern.toml",
  ]) {
    assert.ok(
      errors.some((e) => e.startsWith(needle)),
      `no error for ${needle}: ${errors}`,
    );
  }
});

test("id must equal the file name, and ids and repos must be unique", async () => {
  const root = await tempDir();
  const dir = path.join(root, "plugins");
  await mkdir(dir);
  const base = { tags: ["x"], release_asset_pattern: "*.manangplugin" };
  await writeEntry(dir, "alpha.toml", {
    id: "alpha",
    repo: "https://github.com/a/one",
    ...base,
  });
  await writeEntry(dir, "beta.toml", {
    id: "alpha",
    repo: "https://github.com/a/two",
    ...base,
  });
  await writeEntry(dir, "gamma.toml", {
    id: "gamma",
    repo: "https://github.com/a/one",
    ...base,
  });
  const { errors } = await loadEntries(dir);
  assert.ok(
    errors.some((e) =>
      /beta\.toml: id `alpha` must equal the file name `beta`/.test(e),
    ),
  );
  assert.ok(errors.some((e) => /duplicate id `alpha`/.test(e)));
  assert.ok(
    errors.some((e) => /repository .* is already listed by alpha\.toml/.test(e)),
  );
});

test("the sample entries resolve offline", async () => {
  const { writeSampleFixtures } = await import("../scripts/lib/fixtures.mjs");
  const { REGISTRY_ROOT } = await import("../scripts/lib/cli.mjs");
  const fixtures = await tempDir();
  await writeSampleFixtures(fixtures);
  const r = await resolveAll({
    entriesDir: path.join(REGISTRY_ROOT, "samples/plugins"),
    source: fixtureSource(fixtures),
  });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.results.map((x) => x.plugin.id).sort(), [
    "citation-tools",
    "word-count",
  ]);
});

test("an older broken release is skipped with a warning; a broken latest is fatal", async () => {
  const id = "demo-plugin";
  const good = (v) =>
    release(id, validPlugin({ name: id, version: v }), {
      tag: `v${v}`,
      assetName: `${id}-${v}.manangplugin`,
    });
  const brokenOld = { ...good("0.9.0"), bytes: new TextEncoder().encode("junk") };
  const r = await run({ releases: [good("1.0.0"), brokenOld] });
  assert.deepEqual(r.errors, []);
  assert.equal(r.results[0].plugin.versions.length, 1);
  assert.ok(r.warnings.some((w) => /0\.9\.0: skipped/.test(w)));
  const fatal = await run({
    releases: [
      { ...good("1.0.0"), bytes: new TextEncoder().encode("junk") },
      good("0.9.0"),
    ],
  });
  expectError(fatal, /not a zip/);
});

test("a yanked version is left out of the index, and yanking everything is an error", async () => {
  const id = "demo-plugin";
  const rel = (v) =>
    release(id, validPlugin({ name: id, version: v }), {
      tag: `v${v}`,
      assetName: `${id}-${v}.manangplugin`,
    });
  const r = await run({
    entry: { yanked: ["1.0.0"] },
    releases: [rel("1.0.0"), rel("0.9.0")],
  });
  assert.deepEqual(r.errors, []);
  assert.equal(r.results[0].plugin.latest, "0.9.0");
  assert.deepEqual(
    r.results[0].plugin.versions.map((v) => v.version),
    ["0.9.0"],
  );
  // The withdrawn version is still named, so an installed copy can be flagged.
  assert.deepEqual(r.results[0].plugin.yanked, ["1.0.0"]);
  const all = await run({ entry: { yanked: ["1.0.0"] }, releases: [rel("1.0.0")] });
  expectError(all, /no release of .* has an asset matching/);
});
