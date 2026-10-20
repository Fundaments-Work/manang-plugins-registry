import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { buildRegistry, serialise, verifyRegistry } from "../scripts/lib/build.mjs";
import { REGISTRY_ROOT } from "../scripts/lib/cli.mjs";
import { writeSampleFixtures } from "../scripts/lib/fixtures.mjs";
import { schemaErrors } from "../scripts/lib/schemas.mjs";
import {
  generateKeypair,
  publicKeyOf,
  signBytes,
  verifyBytes,
} from "../scripts/lib/sign.mjs";
import { fixtureSource } from "../scripts/lib/sources.mjs";
import { tempDir } from "./helpers.mjs";

const SAMPLES = path.join(REGISTRY_ROOT, "samples/plugins");
const NOW = new Date("2026-10-19T08:00:00Z");

async function buildSamples(extra = {}) {
  const root = await tempDir();
  const fixtures = path.join(root, "github");
  await writeSampleFixtures(fixtures);
  const keys = generateKeypair();
  const dist = path.join(root, "dist");
  const result = await buildRegistry({
    entriesDir: SAMPLES,
    source: fixtureSource(fixtures),
    outDir: dist,
    signingKey: keys.privateKey,
    now: NOW,
    ...extra,
  });
  return { root, fixtures, dist, keys, result };
}

test("keys: round trip, public key derivation, and wrong key or message fail", () => {
  const a = generateKeypair();
  const b = generateKeypair();
  assert.equal(publicKeyOf(a.privateKey), a.publicKey);
  assert.equal(Buffer.from(a.publicKey, "base64").length, 32);
  const msg = Buffer.from("exact index bytes");
  const sig = signBytes(msg, a.privateKey);
  assert.equal(Buffer.from(sig, "base64").length, 64);
  assert.ok(verifyBytes(msg, sig, a.publicKey));
  assert.ok(!verifyBytes(msg, sig, b.publicKey));
  assert.ok(!verifyBytes(Buffer.from("exact index byteS"), sig, a.publicKey));
  assert.ok(!verifyBytes(msg, "not base64!", a.publicKey));
  assert.throws(() => signBytes(msg, "AAAA"), /32 bytes/);
});

test("a full offline build is valid, signed, deterministic and verifies", async () => {
  const { dist, keys, result, fixtures } = await buildSamples();
  assert.deepEqual(result.errors, []);
  const indexBytes = await readFile(path.join(dist, "index.json"));
  const index = JSON.parse(indexBytes.toString());
  assert.deepEqual(schemaErrors("index", index), []);
  assert.deepEqual(
    schemaErrors(
      "stats",
      JSON.parse(await readFile(path.join(dist, "stats.json"), "utf8")),
    ),
    [],
  );
  assert.equal(index.schema, 1);
  assert.equal(index.generated, "2026-10-19T08:00:00Z");
  assert.deepEqual(
    index.plugins.map((p) => p.id),
    ["citation-tools", "word-count"],
  );
  const wc = index.plugins.find((p) => p.id === "word-count");
  assert.equal(wc.latest, "0.2.0");
  assert.deepEqual(
    wc.versions.map((v) => v.version),
    ["0.2.0", "0.1.0"],
  );
  assert.equal(
    wc.versions[0].download,
    "plugins/word-count/0.2.0/word-count-0.2.0.manangplugin",
  );
  assert.deepEqual(wc.versions[0].permissions, { buffer: ["read:active"] });
  assert.equal(wc.versions[0].changelog, "Fixes counting of CJK text.");
  assert.ok(existsSync(path.join(dist, wc.readme)));
  // The signature covers the exact bytes.
  const sig = (await readFile(path.join(dist, "index.json.sig"), "utf8")).trim();
  assert.ok(verifyBytes(indexBytes, sig, keys.publicKey));
  assert.equal(indexBytes.toString(), serialise(index));
  assert.deepEqual(await verifyRegistry(dist, keys.publicKey), []);

  // Same inputs, same key, same time: identical bytes (ed25519 is deterministic).
  const second = path.join(await tempDir(), "dist");
  const again = await buildRegistry({
    entriesDir: SAMPLES,
    source: fixtureSource(fixtures),
    outDir: second,
    signingKey: keys.privateKey,
    now: NOW,
  });
  assert.deepEqual(again.errors, []);
  assert.equal(
    (await readFile(path.join(second, "index.json"))).toString(),
    indexBytes.toString(),
  );
  assert.equal(await readFile(path.join(second, "index.json.sig"), "utf8"), `${sig}\n`);
});

test("a tampered index fails verification", async () => {
  const { dist, keys } = await buildSamples();
  const file = path.join(dist, "index.json");
  const original = await readFile(file, "utf8");
  // A one-character change, even whitespace, breaks the signature.
  await writeFile(file, original.replace('"latest": "0.2.0"', '"latest": "0.1.0"'));
  const problems = await verifyRegistry(dist, keys.publicKey);
  assert.match(problems[0], /does not verify/);
  await writeFile(file, `${original} `);
  assert.match((await verifyRegistry(dist, keys.publicKey))[0], /does not verify/);
  // And a different key (a rotated or forged one) does not verify the original.
  await writeFile(file, original);
  assert.match(
    (await verifyRegistry(dist, generateKeypair().publicKey))[0],
    /does not verify/,
  );
});

test("a tampered artifact is caught by its sha256", async () => {
  const { dist, keys } = await buildSamples();
  const file = path.join(
    dist,
    "plugins/word-count/0.2.0/word-count-0.2.0.manangplugin",
  );
  const bytes = await readFile(file);
  bytes[bytes.length - 30] ^= 0xff;
  await writeFile(file, bytes);
  const problems = await verifyRegistry(dist, keys.publicKey);
  assert.ok(problems.some((p) => /sha256 mismatch/.test(p)));
});

test("a published version whose release asset changed is a hash mismatch error", async () => {
  const first = await buildSamples();
  const previous = JSON.parse(
    await readFile(path.join(first.dist, "index.json"), "utf8"),
  );
  // The author silently replaces the 0.1.0 asset.
  const { validPlugin, writeFixtureRepo } = await import("../scripts/lib/fixtures.mjs");
  await writeFixtureRepo(first.fixtures, {
    owner: "Fundaments-Work",
    repo: "manang-word-count",
    releases: [
      {
        tag: "v0.2.0",
        assetName: "word-count-0.2.0.manangplugin",
        bytes: validPlugin({
          name: "word-count",
          version: "0.2.0",
          description: "changed after release",
          extra: 'license = "MIT"',
        }),
      },
    ],
  });
  const result = await buildRegistry({
    entriesDir: SAMPLES,
    source: fixtureSource(first.fixtures),
    outDir: path.join(first.root, "dist2"),
    signingKey: first.keys.privateKey,
    previousIndex: previous,
  });
  assert.ok(
    result.errors.some((e) =>
      /word-count 0\.2\.0 was published before with sha256 .* must never change/.test(
        e,
      ),
    ),
  );
  assert.equal(result.indexPath, null);
  assert.ok(!existsSync(path.join(first.root, "dist2")), "nothing is written on error");
});

test("the stats seed carries over and defaults to zero", async () => {
  const { dist } = await buildSamples({
    statsSeed: { downloads: { "word-count": 41, gone: 9 } },
  });
  const stats = JSON.parse(await readFile(path.join(dist, "stats.json"), "utf8"));
  assert.deepEqual(stats, { downloads: { "citation-tools": 0, "word-count": 41 } });
});

test("a build refuses to wipe an unrelated folder", async () => {
  const root = await tempDir();
  await writeFile(path.join(root, "precious.txt"), "keep me");
  const fixtures = path.join(root, "github");
  await writeSampleFixtures(fixtures);
  await assert.rejects(
    buildRegistry({
      entriesDir: SAMPLES,
      source: fixtureSource(fixtures),
      outDir: root,
      signingKey: generateKeypair().privateKey,
    }),
    /not a previous registry build/,
  );
  assert.ok(existsSync(path.join(root, "precious.txt")));
});

test("the index schema rejects drift from the frozen format", () => {
  const good = {
    schema: 1,
    generated: "2026-10-19T08:00:00Z",
    plugins: [],
  };
  assert.deepEqual(schemaErrors("index", good), []);
  assert.notDeepEqual(schemaErrors("index", { ...good, schema: 2 }), []);
  assert.notDeepEqual(schemaErrors("index", { ...good, extra: true }), []);
  const plugin = {
    id: "x-y",
    name: "X",
    author: "a",
    description: "d",
    repo: "https://github.com/a/b",
    license: "MIT",
    tags: [],
    tier: "wasm",
    latest: "1.0.0",
    versions: [
      {
        version: "1.0.0",
        published: "2026-10-10T12:00:00Z",
        download: "plugins/x-y/1.0.0/x-y-1.0.0.manangplugin",
        source: "https://github.com/a/b/releases/download/v1.0.0/x.manangplugin",
        size: 10,
        sha256: "a".repeat(64),
        permissions: {},
        changelog: "",
      },
    ],
  };
  assert.deepEqual(schemaErrors("index", { ...good, plugins: [plugin] }), []);
  const escaping = structuredClone(plugin);
  escaping.versions[0].download = "../etc/passwd";
  assert.notDeepEqual(schemaErrors("index", { ...good, plugins: [escaping] }), []);
  const native = { ...plugin, tier: "native" };
  assert.notDeepEqual(schemaErrors("index", { ...good, plugins: [native] }), []);
});

test("keygen prints the public key and writes the private key only where told", async () => {
  const dir = await tempDir();
  const keyFile = path.join(dir, "registry.key");
  const script = path.join(REGISTRY_ROOT, "scripts/keygen.mjs");
  const ok = spawnSync("node", [script, "--private-out", keyFile], {
    encoding: "utf8",
  });
  assert.equal(ok.status, 0, ok.stderr);
  const secret = (await readFile(keyFile, "utf8")).trim();
  const pub = publicKeyOf(secret);
  assert.ok(ok.stdout.includes(pub));
  assert.ok(!ok.stdout.includes(secret), "the private key is never printed");
  // Refuses to overwrite, and refuses a path inside this repository.
  assert.equal(
    spawnSync("node", [script, "--private-out", keyFile], { encoding: "utf8" }).status,
    1,
  );
  const inside = path.join(REGISTRY_ROOT, "oops.key");
  const bad = spawnSync("node", [script, "--private-out", inside], {
    encoding: "utf8",
  });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /inside the repository/);
  assert.ok(!existsSync(inside));
});

test("the CLIs run end to end", async () => {
  const root = await tempDir();
  const fixtures = path.join(root, "github");
  await writeSampleFixtures(fixtures);
  const keys = generateKeypair();
  const env = { ...process.env, REGISTRY_SIGNING_KEY: keys.privateKey };
  const dist = path.join(root, "dist");
  const scripts = path.join(REGISTRY_ROOT, "scripts");
  const validated = execFileSync(
    "node",
    [path.join(scripts, "validate.mjs"), "--entries", SAMPLES, "--fixtures", fixtures],
    { encoding: "utf8" },
  );
  assert.match(
    validated,
    /capabilities: filesystem read:references; network api\.crossref\.org/,
  );
  execFileSync(
    "node",
    [
      path.join(scripts, "build-index.mjs"),
      "--entries",
      SAMPLES,
      "--fixtures",
      fixtures,
      "--out",
      dist,
    ],
    { env },
  );
  const verified = execFileSync(
    "node",
    [path.join(scripts, "verify-index.mjs"), dist, keys.publicKey],
    { encoding: "utf8" },
  );
  assert.match(verified, /all verify/);
  // No key, no build.
  const noKey = spawnSync(
    "node",
    [
      path.join(scripts, "build-index.mjs"),
      "--entries",
      SAMPLES,
      "--fixtures",
      fixtures,
      "--out",
      dist,
    ],
    {
      env: { ...process.env, REGISTRY_SIGNING_KEY: "" },
      encoding: "utf8",
    },
  );
  assert.equal(noKey.status, 1);
  assert.match(noKey.stderr, /REGISTRY_SIGNING_KEY/);
});
