import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fixtureSource, githubSource } from "./sources.mjs";

export const REGISTRY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
export const DEFAULT_ENTRIES = path.join(REGISTRY_ROOT, "plugins");

/** A fixture directory if given, else the GitHub API (token from GITHUB_TOKEN). */
export function pickSource(fixtures) {
  return fixtures
    ? fixtureSource(path.resolve(fixtures))
    : githubSource({ token: process.env.GITHUB_TOKEN });
}

export async function readJsonIfGiven(file) {
  if (!file) return undefined;
  return JSON.parse(await readFile(file, "utf8"));
}

/** argv without a leading `--` (older pnpm passes it through to the script). */
export function cliArgs() {
  const args = process.argv.slice(2);
  return args[0] === "--" ? args.slice(1) : args;
}
