// Inspecting a `.manangplugin`: the same rules as crates/manang-plugins/src/
// archive.rs (entry names, allowed files, caps), then the manifest's meaning.

import { parse as parseToml } from "smol-toml";
import { ArchiveError, listEntries, readEntry } from "./zip.mjs";

export { ArchiveError };

export const MAX_ENTRIES = 256;
export const MAX_MANIFEST_BYTES = 64 * 1024;
export const MAX_WASM_BYTES = 64 * 1024 * 1024;
export const MAX_ASSET_BYTES = 8 * 1024 * 1024;
export const MAX_README_BYTES = 1024 * 1024;
const MAX_DEPTH = 8;
const MAX_PATH_BYTES = 200;

const NAME_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const HOST_RE = /^[A-Za-z0-9.-]+$/;

/** Mirror of `sanitize_entry`. Returns the path without a trailing slash. */
export function sanitizeEntry(name) {
  const bad = () =>
    new ArchiveError(`entry name \`${name.slice(0, 80)}\` is not a safe relative path`);
  const trimmed = name.endsWith("/") ? name.slice(0, -1) : name;
  if (trimmed.length === 0 || Buffer.byteLength(trimmed) > MAX_PATH_BYTES) throw bad();
  // Control characters are matched on purpose: they are what is being refused.
  // eslint-disable-next-line no-control-regex
  if (/[\\:\u0000-\u001f\u007f]/.test(trimmed)) throw bad();
  const parts = trimmed.split("/");
  if (parts.length > MAX_DEPTH) throw bad();
  for (const part of parts) {
    if (part === "" || part.startsWith(".") || part.trim() !== part) throw bad();
  }
  return trimmed;
}

/** Mirror of `is_allowed`. */
export function isAllowed(path) {
  if (path === "manifest.toml" || path === "plugin.wasm") return true;
  if (path.startsWith("assets/")) return true;
  const upper = path.toUpperCase();
  return (
    !path.includes("/") &&
    ["README", "LICENSE"].some(
      (stem) =>
        upper === stem ||
        (upper.startsWith(stem) && /^[.-]/.test(upper.slice(stem.length))),
    )
  );
}

function limitFor(path) {
  if (path === "manifest.toml") return MAX_MANIFEST_BYTES;
  if (path === "plugin.wasm") return MAX_WASM_BYTES;
  return MAX_ASSET_BYTES;
}

/** Whether a manifest permission entry parses (mirror of capability.rs). */
function permissionError(kind, entry) {
  if (typeof entry !== "string") return `${kind} entries must be strings`;
  if (kind === "network") {
    return entry.length > 0 && HOST_RE.test(entry)
      ? null
      : `\`${entry}\` is not a plain host name (no wildcards, ports or schemes)`;
  }
  const at = entry.indexOf(":");
  if (at < 0) return `\`${entry}\` must look like read:<scope> or write:<scope>`;
  const access = entry.slice(0, at);
  const scope = entry.slice(at + 1);
  if (access !== "read" && access !== "write")
    return `\`${entry}\`: unknown access \`${access}\``;
  if (scope === "") return `\`${entry}\`: empty scope`;
  if (kind === "filesystem") {
    if (/^[/\\]/.test(scope) || scope.split(/[/\\]/).includes("..")) {
      return `\`${entry}\`: the scope must be a relative path without ..`;
    }
  }
  return null;
}

/**
 * Parse `manifest.toml` and check what the registry cares about.
 * @param {string} source
 */
export function parseManifest(source) {
  let doc;
  try {
    doc = parseToml(source);
  } catch (e) {
    throw new ArchiveError(
      `manifest.toml is not valid TOML: ${e instanceof Error ? e.message : e}`,
    );
  }
  const plugin = doc.plugin;
  if (!plugin || typeof plugin !== "object")
    throw new ArchiveError("manifest.toml has no [plugin] table");
  const { name, version } = plugin;
  if (typeof name !== "string" || !NAME_RE.test(name)) {
    throw new ArchiveError(
      `manifest plugin name \`${name}\` is not lowercase kebab-case`,
    );
  }
  if (typeof version !== "string" || !SEMVER_RE.test(version)) {
    throw new ArchiveError(`manifest version \`${version}\` must be MAJOR.MINOR.PATCH`);
  }
  const tier = plugin.tier ?? "wasm";
  if (tier !== "wasm") {
    throw new ArchiveError(
      `manifest tier is \`${tier}\`; only sandboxed \`wasm\` plugins are listed`,
    );
  }
  if (plugin.entry !== undefined && plugin.entry !== "plugin.wasm") {
    throw new ArchiveError(
      "manifest entry must be plugin.wasm (or absent) in an archive",
    );
  }
  for (const key of ["description", "publisher", "license", "homepage"]) {
    if (plugin[key] !== undefined && typeof plugin[key] !== "string") {
      throw new ArchiveError(`manifest ${key} must be a string`);
    }
  }
  const raw = doc.permissions ?? {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ArchiveError("[permissions] must be a table");
  }
  /** @type {{ filesystem?: string[], network?: string[], buffer?: string[] }} */
  const permissions = {};
  for (const [kind, list] of Object.entries(raw)) {
    if (!["filesystem", "network", "buffer"].includes(kind)) {
      throw new ArchiveError(`unknown permission kind \`${kind}\``);
    }
    if (!Array.isArray(list))
      throw new ArchiveError(`permissions.${kind} must be an array`);
    for (const entry of list) {
      const problem = permissionError(kind, entry);
      if (problem) throw new ArchiveError(`permissions.${kind}: ${problem}`);
    }
    if (list.length > 0) permissions[kind] = [...new Set(list)].sort();
  }
  return {
    name,
    version,
    description: plugin.description ?? "",
    publisher: plugin.publisher,
    license: plugin.license,
    homepage: plugin.homepage,
    tier,
    permissions,
  };
}

/** Human-readable capability lines, as the app's consent dialog would list them. */
export function describePermissions(permissions) {
  const lines = [];
  for (const kind of ["filesystem", "network", "buffer"]) {
    for (const e of permissions[kind] ?? []) lines.push(`${kind} ${e}`);
  }
  return lines;
}

/**
 * Read a `.manangplugin` safely and return what the registry needs.
 * @param {Uint8Array} bytes
 */
export function inspectArchive(bytes) {
  const entries = listEntries(bytes, { maxEntries: MAX_ENTRIES });
  const sanitized = entries.map((e) => ({ ...e, path: sanitizeEntry(e.name) }));
  // Files at the root, or all inside one top-level folder.
  let prefix = "";
  const hasRootManifest = sanitized.some((e) => e.path === "manifest.toml");
  if (!hasRootManifest && sanitized.length > 0) {
    const fileEntries = sanitized.filter((e) => !e.isDir);
    const tops = new Set(fileEntries.map((e) => e.path.split("/")[0]));
    if (tops.size === 1 && fileEntries.every((e) => e.path.includes("/")))
      prefix = `${[...tops][0]}/`;
  }
  const seen = new Set();
  const files = new Map();
  let total = 0;
  for (const e of sanitized) {
    if (e.isDir) continue;
    if (prefix && !e.path.startsWith(prefix)) {
      throw new ArchiveError(`\`${e.path}\` is outside the plugin folder`);
    }
    const rel = e.path.slice(prefix.length);
    if (seen.has(rel)) throw new ArchiveError(`\`${rel}\` appears more than once`);
    seen.add(rel);
    if (!isAllowed(rel)) {
      throw new ArchiveError(
        `\`${rel}\` is not allowed in a plugin; only manifest.toml, plugin.wasm, README, LICENSE and assets/ are`,
      );
    }
    const data = readEntry(bytes, e, limitFor(rel));
    total += data.length;
    if (total > MAX_WASM_BYTES + MAX_ASSET_BYTES) {
      throw new ArchiveError("the plugin unpacks to more than the allowed total");
    }
    files.set(rel, data);
  }
  const manifestBytes = files.get("manifest.toml");
  if (!manifestBytes) throw new ArchiveError("the plugin has no `manifest.toml`");
  const wasm = files.get("plugin.wasm");
  if (!wasm) throw new ArchiveError("the plugin has no `plugin.wasm`");
  if (wasm.length < 8 || wasm.readUInt32BE(0) !== 0x0061736d) {
    throw new ArchiveError("plugin.wasm is not a WebAssembly binary (bad magic bytes)");
  }
  let source;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes);
  } catch {
    throw new ArchiveError("manifest.toml is not valid UTF-8");
  }
  const manifest = parseManifest(source);
  return { manifest, files, fileNames: [...files.keys()].sort() };
}

/** Pick the readme: the named file if given, else the first README*. */
export function pickReadme(files, wanted) {
  const names = [...files.keys()].filter((n) => !n.includes("/") && /^README/i.test(n));
  const name = wanted ? names.find((n) => n === wanted) : names.sort()[0];
  if (wanted && !name) {
    throw new ArchiveError(
      `the entry names readme \`${wanted}\` but the archive has no such file`,
    );
  }
  if (!name) return null;
  const data = files.get(name);
  if (data.length > MAX_README_BYTES) {
    throw new ArchiveError(`${name} is larger than ${MAX_README_BYTES} bytes`);
  }
  return { name, data };
}
