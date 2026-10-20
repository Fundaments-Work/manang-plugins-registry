// Where releases come from: the GitHub API, or a local fixture directory that
// has the same shape, so the whole pipeline runs offline in tests.
//
//   <fixtures>/<owner>/<repo>/releases.json   GitHub "list releases" response
//   <fixtures>/<owner>/<repo>/repo.json       { "license": { "spdx_id": "MIT" }, "homepage": "..." }
//   <fixtures>/<owner>/<repo>/assets/<name>   the release asset bytes

import { readFile } from "node:fs/promises";
import path from "node:path";
import { RegistryError } from "./util.mjs";

/** Largest `.manangplugin` the registry will mirror. */
export const MAX_ASSET_BYTES = 20 * 1024 * 1024;

/**
 * @typedef {{ name: string, size: number, url: string }} Asset
 * @typedef {{ tag: string, published: string, body: string, draft: boolean, prerelease: boolean, assets: Asset[] }} Release
 * @typedef {{
 *   listReleases(owner: string, repo: string): Promise<Release[]>,
 *   repoInfo(owner: string, repo: string): Promise<{ license: string | null, homepage: string | null }>,
 *   download(owner: string, repo: string, asset: Asset, maxBytes: number): Promise<Uint8Array>,
 * }} Source
 */

function normaliseRelease(r) {
  return {
    tag: String(r.tag_name ?? ""),
    published: String(r.published_at ?? r.created_at ?? ""),
    body: typeof r.body === "string" ? r.body : "",
    draft: Boolean(r.draft),
    prerelease: Boolean(r.prerelease),
    assets: (r.assets ?? []).map((a) => ({
      name: String(a.name),
      size: Number(a.size),
      url: String(a.browser_download_url),
    })),
  };
}

function normaliseRepo(r) {
  const spdx = r?.license?.spdx_id;
  return {
    license: typeof spdx === "string" && spdx !== "NOASSERTION" ? spdx : null,
    homepage: typeof r?.homepage === "string" && r.homepage ? r.homepage : null,
  };
}

/** @param {string} dir @returns {Source} */
export function fixtureSource(dir) {
  const base = (owner, repo) => path.join(dir, owner, repo);
  return {
    async listReleases(owner, repo) {
      const file = path.join(base(owner, repo), "releases.json");
      let text;
      try {
        text = await readFile(file, "utf8");
      } catch {
        throw new RegistryError(
          `no releases found for ${owner}/${repo} (fixture ${file})`,
        );
      }
      return JSON.parse(text).map(normaliseRelease);
    },
    async repoInfo(owner, repo) {
      try {
        return normaliseRepo(
          JSON.parse(await readFile(path.join(base(owner, repo), "repo.json"), "utf8")),
        );
      } catch {
        return { license: null, homepage: null };
      }
    },
    async download(owner, repo, asset, maxBytes) {
      let bytes;
      try {
        bytes = await readFile(path.join(base(owner, repo), "assets", asset.name));
      } catch {
        throw new RegistryError(`release asset ${asset.name} does not exist (404)`);
      }
      if (bytes.length > maxBytes) {
        throw new RegistryError(`${asset.name} is larger than ${maxBytes} bytes`);
      }
      return new Uint8Array(bytes);
    },
  };
}

/** @param {{ token?: string, fetchImpl?: typeof fetch }} [opts] @returns {Source} */
export function githubSource({ token, fetchImpl = fetch } = {}) {
  const headers = {
    "user-agent": "manang-registry",
    accept: "application/vnd.github+json",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
  async function api(url) {
    const res = await fetchImpl(url, { headers });
    if (!res.ok) throw new RegistryError(`GitHub answered ${res.status} for ${url}`);
    return res.json();
  }
  return {
    async listReleases(owner, repo) {
      const json = await api(
        `https://api.github.com/repos/${owner}/${repo}/releases?per_page=30`,
      );
      return json.map(normaliseRelease);
    },
    async repoInfo(owner, repo) {
      return normaliseRepo(await api(`https://api.github.com/repos/${owner}/${repo}`));
    },
    async download(_owner, _repo, asset, maxBytes) {
      const res = await fetchImpl(asset.url, {
        headers: { "user-agent": "manang-registry" },
        redirect: "follow",
      });
      if (!res.ok || !res.body) {
        throw new RegistryError(`downloading ${asset.name} failed (${res.status})`);
      }
      const declared = Number(res.headers.get("content-length") ?? 0);
      if (declared > maxBytes) {
        throw new RegistryError(`${asset.name} is larger than ${maxBytes} bytes`);
      }
      const chunks = [];
      let total = 0;
      for await (const chunk of res.body) {
        total += chunk.length;
        if (total > maxBytes) {
          throw new RegistryError(`${asset.name} is larger than ${maxBytes} bytes`);
        }
        chunks.push(chunk);
      }
      return new Uint8Array(Buffer.concat(chunks));
    },
  };
}
