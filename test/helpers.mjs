import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after } from "node:test";
import { validPlugin, writeFixtureRepo } from "../scripts/lib/fixtures.mjs";

const made = [];
after(async () => {
  for (const dir of made) await rm(dir, { recursive: true, force: true });
});

export async function tempDir(prefix = "registry-test-") {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
}

/**
 * A one-plugin registry on disk: an entries folder and a fixture "GitHub".
 * `releases` default to one valid v1.0.0; `entry` overrides entry fields.
 */
export async function scenario({
  id = "demo-plugin",
  entry = {},
  releases,
  license,
  extraEntries = {},
} = {}) {
  const root = await tempDir();
  const entriesDir = path.join(root, "plugins");
  const fixtures = path.join(root, "github");
  await mkdir(entriesDir, { recursive: true });
  const fields = {
    id,
    repo: `https://github.com/acme/manang-${id}`,
    tags: ["demo"],
    release_asset_pattern: "*.manangplugin",
    ...entry,
  };
  await writeEntry(entriesDir, `${id}.toml`, fields);
  for (const [file, f] of Object.entries(extraEntries))
    await writeEntry(entriesDir, file, f);
  await writeFixtureRepo(fixtures, {
    owner: "acme",
    repo: `manang-${id}`,
    license,
    releases: releases ?? [
      {
        tag: "v1.0.0",
        assetName: `${id}-1.0.0.manangplugin`,
        bytes: validPlugin({ name: id, version: "1.0.0" }),
      },
    ],
  });
  return { root, entriesDir, fixtures };
}

export async function writeEntry(dir, file, fields) {
  const lines = Object.entries(fields).map(([k, v]) => `${k} = ${JSON.stringify(v)}`);
  await writeFile(path.join(dir, file), `${lines.join("\n")}\n`);
}
