import { createHash } from "node:crypto";

export class RegistryError extends Error {}

/** A released version changed: never skipped, always fatal. */
export class ImmutableError extends RegistryError {}

export function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function out(text = "") {
  process.stdout.write(`${text}\n`);
}

export function warn(text) {
  process.stderr.write(`${text}\n`);
}

/** Compare two MAJOR.MINOR.PATCH strings. */
export function compareSemver(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

/** Glob with `*` only, matching the whole name. */
export function globToRegExp(pattern) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

/** `owner/repo` of a validated GitHub URL. */
export function repoSlug(repoUrl) {
  const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+)$/.exec(repoUrl);
  if (!m) throw new RegistryError(`not a GitHub repository URL: ${repoUrl}`);
  return { owner: m[1], name: m[2] };
}

/** "word-count" becomes "Word count". */
export function displayName(id) {
  const words = id.replace(/-/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}
