#!/usr/bin/env node
// Check a built registry folder the way the app will: signature, schema, and
// every artifact's size and sha256.
//
//   node scripts/verify-index.mjs <dir> <public key base64>

import { verifyRegistry } from "./lib/build.mjs";
import { cliArgs } from "./lib/cli.mjs";
import { out, warn } from "./lib/util.mjs";

const [dir, publicKey] = cliArgs();
if (!dir || !publicKey) {
  warn("usage: node scripts/verify-index.mjs <dir> <public key base64>");
  process.exit(1);
}
const problems = await verifyRegistry(dir, publicKey);
if (problems.length > 0) {
  for (const p of problems) warn(`error: ${p}`);
  process.exit(1);
}
out(`${dir}: signature, schema, sizes and hashes all verify`);
