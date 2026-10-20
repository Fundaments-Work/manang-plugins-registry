// TypeScript mirror of the JSON Schemas in this folder. Keep them in step.

/** The parsed `registry/plugins/<id>.toml`. What an author types. */
export interface RegistryEntry {
  /** Equals the file name and the manifest's `[plugin] name`; kebab-case. */
  id: string;
  /** `https://github.com/<owner>/<repo>` */
  repo: string;
  tags: string[];
  /** File name of the readme inside the archive; defaults to the first README*. */
  readme?: string;
  /** Versions left out of the index (a takedown by the maintainers). */
  yanked?: string[];
  /** Glob (`*` only) selecting the release asset, ends in `.manangplugin`. */
  release_asset_pattern: string;
}

/** The manifest's `[permissions]` table, empty arrays omitted. */
export interface Permissions {
  /** `read:<dir>` / `write:<dir>`, relative to the project. */
  filesystem?: string[];
  /** Exact host names. */
  network?: string[];
  /** `read:<target>` / `write:<target>`, for example `read:active`. */
  buffer?: string[];
}

export interface PluginVersion {
  /** `MAJOR.MINOR.PATCH` */
  version: string;
  /** RFC 3339, the release's publication time. */
  published: string;
  min_app?: string;
  /** Path under the registry base URL (the mirror). */
  download: string;
  /** The author's release asset URL (provenance only). */
  source: string;
  size: number;
  /** Lowercase hex SHA-256 of the archive bytes. */
  sha256: string;
  permissions: Permissions;
  changelog: string;
}

export interface IndexPlugin {
  id: string;
  name: string;
  author: string;
  description: string;
  repo: string;
  homepage?: string;
  /** SPDX expression. */
  license: string;
  tags: string[];
  tier: "wasm";
  /** Path under the registry base URL. */
  readme?: string;
  latest: string;
  /** Newest first. */
  versions: PluginVersion[];
  /** Withdrawn versions: never offered, but an installed copy can be flagged. */
  yanked?: string[];
}

/** `index.json`, schema 1 (frozen). */
export interface RegistryIndex {
  schema: 1;
  /** RFC 3339. */
  generated: string;
  /** Sorted by id. */
  plugins: IndexPlugin[];
}

/** `stats.json`. */
export interface RegistryStats {
  downloads: Record<string, number>;
}
