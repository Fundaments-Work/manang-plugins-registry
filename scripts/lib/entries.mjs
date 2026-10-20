import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { schemaErrors } from "./schemas.mjs";

/**
 * Read and check every `<dir>/<id>.toml`: TOML, shape, id equals file name, and
 * no duplicate ids or repositories. Network-free.
 *
 * @param {string} dir
 * @param {string[]} [only] file names (or paths) to restrict to
 * @returns {Promise<{ entries: { file: string, entry: import("../../schema/types").RegistryEntry }[], errors: string[] }>}
 */
export async function loadEntries(dir, only) {
  const errors = [];
  const entries = [];
  const valid = [];
  let names;
  try {
    names = (await readdir(dir)).filter((n) => !n.startsWith(".")).sort();
  } catch {
    return { entries, errors: [`cannot read the entries folder ${dir}`] };
  }
  const wanted = only?.map((f) => path.basename(f));
  for (const name of names) {
    if (wanted && !wanted.includes(name)) continue;
    if (!name.endsWith(".toml")) {
      if (name.toLowerCase() !== "readme.md")
        errors.push(`${name}: entries must be <id>.toml files`);
      continue;
    }
    const file = name;
    let doc;
    try {
      doc = parseToml(await readFile(path.join(dir, name), "utf8"));
    } catch (e) {
      errors.push(`${file}: not valid TOML: ${e instanceof Error ? e.message : e}`);
      continue;
    }
    const problems = schemaErrors("entry", doc);
    if (problems.length > 0) {
      for (const p of problems) errors.push(`${file}: ${p}`);
      continue;
    }
    valid.push({ file, entry: doc });
    const stem = name.slice(0, -".toml".length);
    if (doc.id !== stem) {
      errors.push(`${file}: id \`${doc.id}\` must equal the file name \`${stem}\``);
      continue;
    }
    entries.push({ file, entry: doc });
  }
  const ids = new Map();
  const repos = new Map();
  for (const { file, entry } of valid) {
    const id = entry.id.toLowerCase();
    if (ids.has(id))
      errors.push(`${file}: duplicate id \`${entry.id}\` (also in ${ids.get(id)})`);
    else ids.set(id, file);
    const repo = entry.repo.toLowerCase();
    if (repos.has(repo))
      errors.push(
        `${file}: repository ${entry.repo} is already listed by ${repos.get(repo)}`,
      );
    else repos.set(repo, file);
  }
  return { entries, errors };
}
