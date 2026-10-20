// Pure request helpers: routing, content types, ETag matching and Range
// parsing. No runtime APIs, so they are easy to unit test.

export type Route =
  | { kind: "index" | "sig" | "stats" }
  | { kind: "artifact"; id: string; version: string; file: string }
  | { kind: "readme"; id: string; version: string | null; file: string };

const ID = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const ARCHIVE_FILE = /^[a-z][a-z0-9-]*-\d+\.\d+\.\d+\.manangplugin$/;
const README_FILE = /^README\.md$/;

/** Map a URL path to what the registry serves, or null for a 404. */
export function route(pathname: string): Route | null {
  switch (pathname) {
    case "/index.json":
      return { kind: "index" };
    case "/index.json.sig":
      return { kind: "sig" };
    case "/stats.json":
      return { kind: "stats" };
  }
  const parts = pathname.split("/");
  // "", "plugins", id, [version,] file
  if (parts[0] !== "" || parts[1] !== "plugins") return null;
  const id = parts[2];
  if (id === undefined || !ID.test(id)) return null;
  if (parts.length === 4 && README_FILE.test(parts[3] ?? "")) {
    return { kind: "readme", id, version: null, file: "README.md" };
  }
  if (parts.length === 5) {
    const version = parts[3] ?? "";
    const file = parts[4] ?? "";
    if (!VERSION.test(version)) return null;
    if (README_FILE.test(file)) return { kind: "readme", id, version, file };
    if (ARCHIVE_FILE.test(file) && file === `${id}-${version}.manangplugin`) {
      return { kind: "artifact", id, version, file };
    }
  }
  return null;
}

/** The R2 key of a route that maps straight to an object. */
export function keyFor(r: Route): string | null {
  switch (r.kind) {
    case "index":
      return "index.json";
    case "sig":
      return "index.json.sig";
    case "stats":
      return null;
    case "artifact":
      return `plugins/${r.id}/${r.version}/${r.file}`;
    case "readme":
      return r.version
        ? `plugins/${r.id}/${r.version}/${r.file}`
        : `plugins/${r.id}/${r.file}`;
  }
}

export function contentType(r: Route): string {
  switch (r.kind) {
    case "index":
    case "stats":
      return "application/json; charset=utf-8";
    case "sig":
      return "text/plain; charset=utf-8";
    case "artifact":
      return "application/zip";
    case "readme":
      return "text/markdown; charset=utf-8";
  }
}

/** Index, signature, stats and the moving readme change; versioned files never do. */
export function cacheControl(r: Route): string {
  if (r.kind === "artifact" || (r.kind === "readme" && r.version !== null)) {
    return "public, max-age=31536000, immutable";
  }
  return "public, max-age=300";
}

/** Does `If-None-Match` match this strong ETag? (`*` and weak forms count.) */
export function etagMatches(header: string | null, etag: string): boolean {
  if (header === null) return false;
  const strip = (t: string) => t.trim().replace(/^W\//, "");
  return header.split(",").some((t) => strip(t) === "*" || strip(t) === etag);
}

export type RangeResult =
  | { kind: "none" }
  | { kind: "unsatisfiable" }
  | { kind: "range"; start: number; end: number };

/**
 * One `bytes=` range against an object of `size` bytes (RFC 9110). Anything
 * malformed, or a multi-range request, is ignored and the whole file is served.
 */
export function parseRange(header: string | null, size: number): RangeResult {
  if (header === null) return { kind: "none" };
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return { kind: "none" };
  const [, a = "", b = ""] = m;
  if (a === "") {
    const n = Number(b);
    if (n === 0 || size === 0) return { kind: "unsatisfiable" };
    return { kind: "range", start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(a);
  const end = b === "" ? size - 1 : Number(b);
  if (b !== "" && end < start) return { kind: "none" };
  if (start >= size) return { kind: "unsatisfiable" };
  return { kind: "range", start, end: Math.min(end, size - 1) };
}
