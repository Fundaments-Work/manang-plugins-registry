#!/usr/bin/env node
// Validate registry entries (what a pull request runs).
//
//   node scripts/validate.mjs [--entries <dir>] [--fixtures <dir>] [--previous <index.json>] [file.toml ...]
//
// For every entry: the TOML shape, id == file name == manifest name, the release
// asset exists and downloads, it is a well-formed .manangplugin with a valid
// manifest (tier wasm), size cap, licence is SPDX. Lists the capabilities each
// version asks for. Exits 1 on any error. Nothing is written.

import { parseArgs } from "node:util";
import { describePermissions } from "./lib/archive.mjs";
import { resolveAll } from "./lib/build.mjs";
import { DEFAULT_ENTRIES, cliArgs, pickSource, readJsonIfGiven } from "./lib/cli.mjs";
import { out, warn } from "./lib/util.mjs";

const { values, positionals } = parseArgs({
  args: cliArgs(),
  allowPositionals: true,
  options: {
    entries: { type: "string", default: DEFAULT_ENTRIES },
    fixtures: { type: "string" },
    previous: { type: "string" },
  },
});

const { results, errors, warnings } = await resolveAll({
  entriesDir: values.entries,
  source: pickSource(values.fixtures),
  only: positionals.length > 0 ? positionals : undefined,
  previousIndex: await readJsonIfGiven(values.previous),
});

for (const { file, plugin } of results) {
  out(
    `ok  ${file}: ${plugin.id} ${plugin.latest} (${plugin.versions.length} version(s), ${plugin.license})`,
  );
  for (const v of plugin.versions) {
    const caps = describePermissions(v.permissions);
    out(`      ${v.version}  ${v.size} bytes  sha256 ${v.sha256.slice(0, 12)}...`);
    out(`        capabilities: ${caps.length === 0 ? "none" : caps.join("; ")}`);
  }
}
for (const w of warnings) warn(`warning: ${w}`);
for (const e of errors) warn(`error: ${e}`);
if (results.length === 0 && errors.length === 0) out("no entries to validate");
if (errors.length > 0) {
  warn(`${errors.length} error(s)`);
  process.exit(1);
}
