// Turn one registry entry into an index plugin: find its releases, download and
// inspect every archive, and read everything else from the manifest.

import parseSpdx from "spdx-expression-parse";
import { inspectArchive, pickReadme } from "./archive.mjs";
import { MAX_ASSET_BYTES } from "./sources.mjs";
import {
  ImmutableError,
  RegistryError,
  compareSemver,
  displayName,
  globToRegExp,
  repoSlug,
  sha256Hex,
} from "./util.mjs";

/** Most versions listed per plugin (newest first). */
export const MAX_VERSIONS = 10;
const MAX_CHANGELOG = 4000;

/** Throws unless `text` is a plain SPDX expression of known ids. */
export function checkSpdx(text) {
  if (
    typeof text !== "string" ||
    text.trim() === "" ||
    /LicenseRef|NOASSERTION|NONE/.test(text)
  ) {
    throw new RegistryError(`licence \`${text}\` is not an SPDX identifier`);
  }
  try {
    parseSpdx(text);
  } catch {
    throw new RegistryError(`licence \`${text}\` is not a valid SPDX expression`);
  }
}

function tagVersion(tag) {
  const v = tag.replace(/^v/, "");
  return /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(v) ? v : null;
}

/**
 * @param {import("../../schema/types").RegistryEntry} entry
 * @param {import("./sources.mjs").Source} source
 * @param {{
 *   previous?: Map<string, { size: number, sha256: string }>,
 *   maxBytes?: number,
 * }} [opts] `previous` maps `<version>` of an earlier published index to its
 *   size and hash: a released version must never change.
 * @returns {Promise<{
 *   plugin: import("../../schema/types").IndexPlugin,
 *   artifacts: { version: string, bytes: Uint8Array, readme: Uint8Array | null }[],
 *   warnings: string[],
 * }>}
 */
export async function resolveEntry(entry, source, opts = {}) {
  const { previous = new Map(), maxBytes = MAX_ASSET_BYTES } = opts;
  const { owner, name: repoName } = repoSlug(entry.repo);
  const pattern = globToRegExp(entry.release_asset_pattern);
  const warnings = [];

  const releases = (await source.listReleases(owner, repoName))
    .filter((r) => !r.draft && !r.prerelease)
    .map((r) => ({ r, version: tagVersion(r.tag) }))
    .filter(({ r, version }) => {
      if (version === null)
        warnings.push(`release tag \`${r.tag}\` is not vMAJOR.MINOR.PATCH; skipped`);
      return version !== null;
    })
    .sort((a, b) => compareSemver(b.version, a.version));

  const candidates = [];
  const yanked = new Set(entry.yanked ?? []);
  for (const { r, version } of releases) {
    if (yanked.has(version)) continue;
    const assets = r.assets.filter((a) => pattern.test(a.name));
    if (assets.length === 0) continue;
    candidates.push({ r, version, assets });
  }
  if (candidates.length === 0) {
    throw new RegistryError(
      `${entry.id}: no release of ${entry.repo} has an asset matching \`${entry.release_asset_pattern}\``,
    );
  }

  const versions = [];
  const artifacts = [];
  let meta = null;
  let readmeFor = null;

  for (const [index, { r, version, assets }] of candidates
    .slice(0, MAX_VERSIONS)
    .entries()) {
    const isLatest = index === 0;
    try {
      if (assets.length > 1) {
        throw new RegistryError(
          `release ${r.tag} has ${assets.length} assets matching the pattern (${assets.map((a) => a.name).join(", ")}); make the pattern select exactly one`,
        );
      }
      const asset = assets[0];
      if (asset.size > maxBytes) {
        throw new RegistryError(
          `${asset.name} is ${asset.size} bytes; the limit is ${maxBytes}`,
        );
      }
      if (!asset.url.startsWith("https://")) {
        throw new RegistryError(`${asset.name} has no https download URL`);
      }
      const bytes = await source.download(owner, repoName, asset, maxBytes);
      if (bytes.length > maxBytes) {
        throw new RegistryError(
          `${asset.name} is ${bytes.length} bytes; the limit is ${maxBytes}`,
        );
      }
      if (bytes.length === 0) throw new RegistryError(`${asset.name} is empty`);
      const sha256 = sha256Hex(bytes);

      let inspected;
      try {
        inspected = inspectArchive(bytes);
      } catch (e) {
        throw new RegistryError(`${asset.name}: ${e instanceof Error ? e.message : e}`);
      }
      const m = inspected.manifest;
      if (m.name !== entry.id) {
        throw new RegistryError(
          `${asset.name}: manifest plugin name \`${m.name}\` must equal the entry id \`${entry.id}\``,
        );
      }
      if (m.version !== version) {
        throw new RegistryError(
          `${asset.name}: manifest version ${m.version} does not match the release tag ${r.tag}`,
        );
      }
      const earlier = previous.get(version);
      if (earlier && (earlier.sha256 !== sha256 || earlier.size !== bytes.length)) {
        throw new ImmutableError(
          `${entry.id} ${version} was published before with sha256 ${earlier.sha256} but the release asset now hashes to ${sha256}; a released version must never change (cut a new version instead)`,
        );
      }
      const published = new Date(r.published);
      if (Number.isNaN(published.getTime())) {
        throw new RegistryError(`release ${r.tag} has no valid publication date`);
      }
      const readme = pickReadme(inspected.files, entry.readme);

      versions.push({
        version,
        published: published.toISOString(),
        download: `plugins/${entry.id}/${version}/${entry.id}-${version}.manangplugin`,
        source: asset.url,
        size: bytes.length,
        sha256,
        permissions: m.permissions,
        changelog: r.body.trim().slice(0, MAX_CHANGELOG),
      });
      artifacts.push({ version, bytes, readme: readme ? readme.data : null });
      if (isLatest) {
        meta = m;
        readmeFor = readme;
      }
    } catch (e) {
      if (!(e instanceof RegistryError) || e instanceof ImmutableError) throw e;
      if (isLatest) throw e;
      warnings.push(`${entry.id} ${version}: skipped (${e.message})`);
    }
  }
  if (!meta) throw new RegistryError(`${entry.id}: no usable release`);

  const info = await source.repoInfo(owner, repoName);
  const license = meta.license ?? info.license;
  if (!license) {
    throw new RegistryError(
      `${entry.id}: no licence found. Add \`license = "<SPDX id>"\` under [plugin] in manifest.toml, or set a licence on the GitHub repository`,
    );
  }
  checkSpdx(license);
  if (!meta.description.trim()) {
    throw new RegistryError(`${entry.id}: the manifest needs a non-empty description`);
  }
  const homepage = meta.homepage ?? info.homepage;
  if (meta.homepage && !/^https?:\/\//.test(meta.homepage)) {
    throw new RegistryError(`${entry.id}: manifest homepage must be an http(s) URL`);
  }

  /** @type {import("../../schema/types").IndexPlugin} */
  const plugin = {
    id: entry.id,
    name: displayName(entry.id),
    author: meta.publisher?.trim() || owner,
    description: meta.description.trim().slice(0, 500),
    repo: entry.repo,
    ...(homepage && /^https?:\/\//.test(homepage) ? { homepage } : {}),
    license,
    tags: entry.tags,
    tier: "wasm",
    ...(readmeFor ? { readme: `plugins/${entry.id}/README.md` } : {}),
    latest: versions[0].version,
    versions,
    // Withdrawn versions are not offered; the list lets an app that already has
    // one installed say so ("withdrawn") instead of silently showing nothing.
    ...(yanked.size > 0 ? { yanked: [...yanked].sort(compareSemver) } : {}),
  };
  return { plugin, artifacts, warnings };
}
