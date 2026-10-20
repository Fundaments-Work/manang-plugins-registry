// Build the publishable registry tree: index.json, index.json.sig, stats.json
// and the mirrored artifacts and readmes.

import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadEntries } from "./entries.mjs";
import { resolveEntry } from "./resolve.mjs";
import { schemaErrors } from "./schemas.mjs";
import { signBytes, publicKeyOf, verifyBytes } from "./sign.mjs";
import { RegistryError } from "./util.mjs";

/**
 * Resolve every entry. Collects errors per entry instead of stopping at the
 * first, so a pull request sees every problem at once.
 *
 * @param {{ entriesDir: string, source: import("./sources.mjs").Source, only?: string[], previousIndex?: any }} args
 */
export async function resolveAll({ entriesDir, source, only, previousIndex }) {
  const { entries, errors } = await loadEntries(entriesDir, only);
  const results = [];
  const warnings = [];
  const previousById = new Map();
  for (const p of previousIndex?.plugins ?? []) {
    previousById.set(p.id, new Map(p.versions.map((v) => [v.version, v])));
  }
  for (const { file, entry } of entries) {
    try {
      const r = await resolveEntry(entry, source, {
        previous: previousById.get(entry.id),
      });
      results.push({ file, ...r });
      for (const w of r.warnings) warnings.push(`${file}: ${w}`);
    } catch (e) {
      if (!(e instanceof RegistryError)) throw e;
      errors.push(`${file}: ${e.message}`);
    }
  }
  const seen = new Map();
  for (const r of results) {
    if (seen.has(r.plugin.id)) {
      errors.push(
        `${r.file}: duplicate plugin id \`${r.plugin.id}\` (also from ${seen.get(r.plugin.id)})`,
      );
    }
    seen.set(r.plugin.id, r.file);
  }
  return { results, errors, warnings };
}

/** Empty a previous build output, but never an unrelated folder. */
async function prepareOutDir(outDir) {
  let names = [];
  try {
    names = await readdir(outDir);
  } catch {
    // Does not exist yet.
  }
  if (names.length > 0 && !names.includes("index.json")) {
    throw new RegistryError(
      `${outDir} is not empty and is not a previous registry build; pick an empty --out folder`,
    );
  }
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
}

/** Serialise exactly as published: two-space JSON and a trailing newline. */
export function serialise(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * @param {{
 *   entriesDir: string,
 *   source: import("./sources.mjs").Source,
 *   outDir: string,
 *   signingKey: string,
 *   previousIndex?: any,
 *   statsSeed?: { downloads: Record<string, number> },
 *   now?: Date,
 * }} args
 */
export async function buildRegistry({
  entriesDir,
  source,
  outDir,
  signingKey,
  previousIndex,
  statsSeed,
  now = new Date(),
}) {
  const { results, errors, warnings } = await resolveAll({
    entriesDir,
    source,
    previousIndex,
  });
  if (errors.length > 0) return { errors, warnings, indexPath: null };

  results.sort((a, b) => (a.plugin.id < b.plugin.id ? -1 : 1));
  const index = {
    schema: 1,
    generated: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
    plugins: results.map((r) => r.plugin),
  };
  const bad = schemaErrors("index", index);
  if (bad.length > 0)
    return { errors: bad.map((b) => `index.json: ${b}`), warnings, indexPath: null };

  const downloads = {};
  for (const r of results)
    downloads[r.plugin.id] = statsSeed?.downloads?.[r.plugin.id] ?? 0;
  const stats = { downloads };
  const badStats = schemaErrors("stats", stats);
  if (badStats.length > 0)
    return {
      errors: badStats.map((b) => `stats.json: ${b}`),
      warnings,
      indexPath: null,
    };

  await prepareOutDir(outDir);
  for (const r of results) {
    for (const a of r.artifacts) {
      const dir = path.join(outDir, "plugins", r.plugin.id, a.version);
      await mkdir(dir, { recursive: true });
      await writeFile(
        path.join(dir, `${r.plugin.id}-${a.version}.manangplugin`),
        a.bytes,
      );
      if (a.readme) await writeFile(path.join(dir, "README.md"), a.readme);
    }
    // The plugin-level readme is the latest version's.
    const latest = r.artifacts.find((a) => a.version === r.plugin.latest);
    if (r.plugin.readme && latest?.readme) {
      await writeFile(path.join(outDir, r.plugin.readme), latest.readme);
    }
  }
  const indexBytes = Buffer.from(serialise(index), "utf8");
  const signature = signBytes(indexBytes, signingKey);
  // Never publish a signature we cannot verify with the key's own public half.
  if (!verifyBytes(indexBytes, signature, publicKeyOf(signingKey))) {
    throw new RegistryError("internal error: the fresh signature does not verify");
  }
  const indexPath = path.join(outDir, "index.json");
  await writeFile(indexPath, indexBytes);
  await writeFile(`${indexPath}.sig`, `${signature}\n`);
  await writeFile(path.join(outDir, "stats.json"), serialise(stats));
  return { errors: [], warnings, indexPath, index, stats };
}

/**
 * Verify a built registry tree the way the app does: signature over the exact
 * bytes, schema, then every artifact's size and sha256.
 * Returns a list of problems (empty when everything checks out).
 */
export async function verifyRegistry(dir, publicKeyB64) {
  const problems = [];
  const indexBytes = await readFile(path.join(dir, "index.json"));
  const sig = (await readFile(path.join(dir, "index.json.sig"), "utf8")).trim();
  if (!verifyBytes(indexBytes, sig, publicKeyB64)) {
    return ["index.json.sig does not verify against the public key"];
  }
  let index;
  try {
    index = JSON.parse(indexBytes.toString("utf8"));
  } catch {
    return ["index.json is not valid JSON"];
  }
  for (const p of schemaErrors("index", index)) problems.push(`index.json: ${p}`);
  if (problems.length > 0) return problems;
  const { createHash } = await import("node:crypto");
  for (const plugin of index.plugins) {
    for (const v of plugin.versions) {
      let bytes;
      try {
        bytes = await readFile(path.join(dir, v.download));
      } catch {
        problems.push(`${plugin.id} ${v.version}: ${v.download} is missing`);
        continue;
      }
      if (bytes.length !== v.size)
        problems.push(`${plugin.id} ${v.version}: size mismatch`);
      if (createHash("sha256").update(bytes).digest("hex") !== v.sha256) {
        problems.push(`${plugin.id} ${v.version}: sha256 mismatch`);
      }
    }
  }
  return problems;
}
