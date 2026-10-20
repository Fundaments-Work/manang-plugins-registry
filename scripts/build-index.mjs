#!/usr/bin/env node
// Build the publishable registry tree and sign it.
//
//   REGISTRY_SIGNING_KEY=<base64 seed> node scripts/build-index.mjs \
//     [--entries <dir>] [--fixtures <dir>] [--out dist] \
//     [--previous <index.json>] [--stats-seed <stats.json>] [--now <ISO date>]
//
// Writes <out>/index.json, index.json.sig, stats.json and
// <out>/plugins/<id>/<version>/ (artifact and readme). `--previous` is the
// currently published index: a version listed there may never change.

import { parseArgs } from "node:util";
import { buildRegistry } from "./lib/build.mjs";
import { DEFAULT_ENTRIES, cliArgs, pickSource, readJsonIfGiven } from "./lib/cli.mjs";
import { out, warn } from "./lib/util.mjs";

const { values } = parseArgs({
  args: cliArgs(),
  options: {
    entries: { type: "string", default: DEFAULT_ENTRIES },
    fixtures: { type: "string" },
    out: { type: "string", default: "dist" },
    previous: { type: "string" },
    "stats-seed": { type: "string" },
    now: { type: "string" },
  },
});

const signingKey = process.env.REGISTRY_SIGNING_KEY;
if (!signingKey) {
  warn("error: set REGISTRY_SIGNING_KEY (base64 seed from `pnpm run keygen`)");
  process.exit(1);
}

const result = await buildRegistry({
  entriesDir: values.entries,
  source: pickSource(values.fixtures),
  outDir: values.out,
  signingKey,
  previousIndex: await readJsonIfGiven(values.previous),
  statsSeed: await readJsonIfGiven(values["stats-seed"]),
  now: values.now ? new Date(values.now) : undefined,
});
for (const w of result.warnings) warn(`warning: ${w}`);
if (result.errors.length > 0) {
  for (const e of result.errors) warn(`error: ${e}`);
  warn(`${result.errors.length} error(s); nothing was written`);
  process.exit(1);
}
const n = result.index.plugins.length;
out(
  `wrote ${values.out}/index.json (${n} plugin${n === 1 ? "" : "s"}), index.json.sig, stats.json`,
);
