#!/usr/bin/env node
// End-to-end offline run: make the sample fixtures, validate the sample
// entries, build and sign the index with a throwaway key, and verify it.
//
//   node scripts/demo.mjs [out-dir]     (default: demo-out, git-ignored)

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { buildRegistry, verifyRegistry } from "./lib/build.mjs";
import { REGISTRY_ROOT } from "./lib/cli.mjs";
import { writeSampleFixtures } from "./lib/fixtures.mjs";
import { generateKeypair } from "./lib/sign.mjs";
import { fixtureSource } from "./lib/sources.mjs";
import { out, warn } from "./lib/util.mjs";

const outDir = path.resolve(process.argv[2] ?? path.join(REGISTRY_ROOT, "demo-out"));
const fixtures = path.join(outDir, "fixtures");
const dist = path.join(outDir, "dist");
await mkdir(fixtures, { recursive: true });
await writeSampleFixtures(fixtures);

const { privateKey, publicKey } = generateKeypair();
const result = await buildRegistry({
  entriesDir: path.join(REGISTRY_ROOT, "samples/plugins"),
  source: fixtureSource(fixtures),
  outDir: dist,
  signingKey: privateKey,
});
for (const w of result.warnings) warn(`warning: ${w}`);
if (result.errors.length > 0) {
  for (const e of result.errors) warn(`error: ${e}`);
  process.exit(1);
}
const problems = await verifyRegistry(dist, publicKey);
if (problems.length > 0) {
  for (const p of problems) warn(`error: ${p}`);
  process.exit(1);
}
out(`built and verified ${result.index.plugins.length} sample plugins in ${dist}`);
out(`(throwaway public key ${publicKey}; the private key was discarded)`);
