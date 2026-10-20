// Fixture archives and fixture "GitHub" trees for offline runs and tests.
// The wasm inside is a stub (just the 8-byte WebAssembly header): enough for the
// registry's checks, never meant to run.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { zipSync } from "fflate";
import { REGISTRY_ROOT } from "./cli.mjs";

const enc = new TextEncoder();
export const WASM_STUB = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
]);
/** A fixed time so archives are byte-for-byte reproducible. */
const MTIME = new Date("2026-01-01T00:00:00Z");

export function manifestText({
  name = "demo-plugin",
  version = "1.0.0",
  description = "A demo plugin.",
  extra = "",
  permissions = "",
} = {}) {
  return `[plugin]
name = "${name}"
version = "${version}"
description = "${description}"
${extra}
${permissions}
`;
}

/**
 * Build a `.manangplugin` zip. `files` maps path to string or bytes; a value of
 * `{ symlink: "target" }` makes a symbolic link entry. `folder` puts everything
 * in one top-level folder.
 */
export function makeArchive(files, { folder = "" } = {}) {
  const tree = {};
  for (const [name, value] of Object.entries(files)) {
    const key = folder ? `${folder}/${name}` : name;
    if (value && typeof value === "object" && "symlink" in value) {
      tree[key] = [
        enc.encode(value.symlink),
        { mtime: MTIME, os: 3, attrs: 0o120777 << 16 },
      ];
    } else {
      const data = typeof value === "string" ? enc.encode(value) : value;
      tree[key] = [data, { mtime: MTIME, os: 3, attrs: 0o100644 << 16, level: 6 }];
    }
  }
  return zipSync(tree);
}

/** A valid plugin archive. Pass overrides to break one thing at a time. */
export function validPlugin(opts = {}) {
  const { files, ...manifest } = opts;
  return makeArchive({
    "manifest.toml": manifestText(manifest),
    "plugin.wasm": WASM_STUB,
    "README.md": `# ${manifest.name ?? "demo-plugin"}\n\nA demo plugin.\n`,
    ...files,
  });
}

/**
 * Write `<dir>/<owner>/<repo>/{releases.json,repo.json,assets/*}`.
 * @param {string} dir
 * @param {{ owner: string, repo: string, license?: string | null, homepage?: string,
 *   releases: { tag: string, published?: string, body?: string, assetName: string, bytes: Uint8Array,
 *     prerelease?: boolean, draft?: boolean, declaredSize?: number }[] }} spec
 */
export async function writeFixtureRepo(dir, spec) {
  const base = path.join(dir, spec.owner, spec.repo);
  await mkdir(path.join(base, "assets"), { recursive: true });
  const releases = [];
  for (const r of spec.releases) {
    await writeFile(path.join(base, "assets", r.assetName), r.bytes);
    releases.push({
      tag_name: r.tag,
      published_at: r.published ?? "2026-10-10T12:00:00Z",
      body: r.body ?? "",
      draft: r.draft ?? false,
      prerelease: r.prerelease ?? false,
      assets: [
        {
          name: r.assetName,
          size: r.declaredSize ?? r.bytes.length,
          browser_download_url: `https://github.com/${spec.owner}/${spec.repo}/releases/download/${r.tag}/${r.assetName}`,
        },
      ],
    });
  }
  await writeFile(
    path.join(base, "releases.json"),
    `${JSON.stringify(releases, null, 2)}\n`,
  );
  await writeFile(
    path.join(base, "repo.json"),
    `${JSON.stringify(
      {
        license: spec.license === null ? null : { spdx_id: spec.license ?? "MIT" },
        homepage: spec.homepage ?? "",
      },
      null,
      2,
    )}\n`,
  );
}

/** The two sample plugins used by `pnpm run demo` and the tests. */
export async function writeSampleFixtures(dir) {
  // The real first-party manifest, version bumped, with the stub wasm.
  const real = await readFile(
    path.join(REGISTRY_ROOT, "../plugins/word-count/manifest.toml"),
    "utf8",
  );
  const wordCount = (version) =>
    makeArchive({
      "manifest.toml": real
        .replace(/^version = ".*"$/m, `version = "${version}"`)
        .replace(/^\[plugin\]$/m, '[plugin]\nlicense = "MIT"'),
      "plugin.wasm": WASM_STUB,
      "README.md": `# Word count\n\nCounts words, characters and lines (version ${version}).\n`,
      LICENSE: "MIT License (sample)\n",
    });
  await writeFixtureRepo(dir, {
    owner: "Fundaments-Work",
    repo: "manang-word-count",
    homepage: "https://example.org/word-count",
    releases: [
      {
        tag: "v0.1.0",
        published: "2026-09-01T09:00:00Z",
        body: "First release.",
        assetName: "word-count-0.1.0.manangplugin",
        bytes: wordCount("0.1.0"),
      },
      {
        tag: "v0.2.0",
        published: "2026-10-10T12:00:00Z",
        body: "Fixes counting of CJK text.",
        assetName: "word-count-0.2.0.manangplugin",
        bytes: wordCount("0.2.0"),
      },
    ],
  });
  await writeFixtureRepo(dir, {
    owner: "example",
    repo: "manang-citation-tools",
    license: "Apache-2.0", // taken from the repository, the manifest has none
    releases: [
      {
        tag: "v1.0.0",
        published: "2026-10-05T08:30:00Z",
        body: "Looks up DOIs on Crossref.",
        assetName: "citation-tools-1.0.0.manangplugin",
        bytes: validPlugin({
          name: "citation-tools",
          version: "1.0.0",
          description: "Looks up a DOI and inserts a BibTeX entry.",
          extra: 'publisher = "Example Lab"',
          permissions:
            '[permissions]\nfilesystem = ["read:references"]\nnetwork = ["api.crossref.org"]',
        }),
      },
    ],
  });
}
