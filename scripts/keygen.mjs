#!/usr/bin/env node
// Generate the registry's ed25519 signing keypair.
//
//   node scripts/keygen.mjs --private-out <path outside the repo>
//
// Prints the PUBLIC key in the form the app embeds (base64 of the raw 32 bytes).
// The private key (base64 of the 32-byte seed, the value of the CI secret
// REGISTRY_SIGNING_KEY) is written only to --private-out, mode 0600, and is
// never printed. The path must not exist and must not be inside this repository.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { cliArgs } from "./lib/cli.mjs";
import { generateKeypair } from "./lib/sign.mjs";
import { out, warn } from "./lib/util.mjs";

const { values } = parseArgs({
  args: cliArgs(),
  options: { "private-out": { type: "string" } },
});
const target = values["private-out"];
if (!target) {
  warn("usage: node scripts/keygen.mjs --private-out <file outside the repository>");
  process.exit(1);
}
const dest = path.resolve(target);
if (existsSync(dest)) {
  warn(`error: ${dest} already exists; refusing to overwrite a key`);
  process.exit(1);
}
let repoRoot = null;
try {
  repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname)),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
} catch {
  // Not a git checkout: nothing to guard against.
}
if (repoRoot && (dest === repoRoot || dest.startsWith(`${repoRoot}${path.sep}`))) {
  warn(
    `error: ${dest} is inside the repository (${repoRoot}); a private key must never be committed`,
  );
  process.exit(1);
}

const { privateKey, publicKey } = generateKeypair();
await writeFile(dest, `${privateKey}\n`, { mode: 0o600, flag: "wx" });
out(
  `private key written to ${dest} (keep it secret; store it as the CI secret REGISTRY_SIGNING_KEY)`,
);
out("");
out("public key, to embed in the app:");
out(publicKey);
