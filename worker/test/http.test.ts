import { describe, expect, it } from "vitest";
import { etagMatches, keyFor, parseRange, route } from "../src/http";

describe("route", () => {
  it("accepts exactly the served paths", () => {
    expect(route("/index.json")).toEqual({ kind: "index" });
    expect(route("/index.json.sig")).toEqual({ kind: "sig" });
    expect(route("/stats.json")).toEqual({ kind: "stats" });
    expect(route("/plugins/word-count/README.md")).toEqual({
      kind: "readme",
      id: "word-count",
      version: null,
      file: "README.md",
    });
    expect(route("/plugins/word-count/0.2.0/README.md")).toMatchObject({
      kind: "readme",
      version: "0.2.0",
    });
    const artifact = route("/plugins/word-count/0.2.0/word-count-0.2.0.manangplugin");
    expect(artifact).toEqual({
      kind: "artifact",
      id: "word-count",
      version: "0.2.0",
      file: "word-count-0.2.0.manangplugin",
    });
    expect(keyFor(artifact!)).toBe(
      "plugins/word-count/0.2.0/word-count-0.2.0.manangplugin",
    );
    expect(
      keyFor({ kind: "readme", id: "a-b", version: null, file: "README.md" }),
    ).toBe("plugins/a-b/README.md");
  });

  it("rejects everything else", () => {
    for (const p of [
      "/",
      "/health",
      "/index.json/",
      "/Index.json",
      "/plugins",
      "/plugins/",
      "/plugins/word-count",
      "/plugins/Word-Count/README.md",
      "/plugins/word-count/latest/word-count-latest.manangplugin",
      "/plugins/word-count/0.2.0/other-0.2.0.manangplugin",
      "/plugins/word-count/0.2.0/word-count-0.2.0.zip",
      "/plugins/word-count/0.2.0/",
      "/plugins/word-count/0.2.0/README.txt",
      "/plugins/word-count/0.2.0/extra/README.md",
      "/plugins/../index.json",
      "/plugins/word-count/..%2Findex.json",
      "//plugins/word-count/README.md",
    ]) {
      expect(route(p), p).toBeNull();
    }
  });
});

describe("etagMatches", () => {
  it("handles lists, weak forms and *", () => {
    expect(etagMatches(null, '"a"')).toBe(false);
    expect(etagMatches('"a"', '"a"')).toBe(true);
    expect(etagMatches('"b", "a"', '"a"')).toBe(true);
    expect(etagMatches('W/"a"', '"a"')).toBe(true);
    expect(etagMatches("*", '"a"')).toBe(true);
    expect(etagMatches('"b"', '"a"')).toBe(false);
  });
});

describe("parseRange", () => {
  it("parses single ranges against a size", () => {
    expect(parseRange(null, 100)).toEqual({ kind: "none" });
    expect(parseRange("bytes=0-9", 100)).toEqual({ kind: "range", start: 0, end: 9 });
    expect(parseRange("bytes=90-", 100)).toEqual({ kind: "range", start: 90, end: 99 });
    expect(parseRange("bytes=90-500", 100)).toEqual({
      kind: "range",
      start: 90,
      end: 99,
    });
    expect(parseRange("bytes=-10", 100)).toEqual({ kind: "range", start: 90, end: 99 });
    expect(parseRange("bytes=-500", 100)).toEqual({ kind: "range", start: 0, end: 99 });
  });

  it("flags unsatisfiable ranges and ignores malformed or multiple ones", () => {
    expect(parseRange("bytes=100-", 100)).toEqual({ kind: "unsatisfiable" });
    expect(parseRange("bytes=-0", 100)).toEqual({ kind: "unsatisfiable" });
    expect(parseRange("bytes=0-1", 0)).toEqual({ kind: "unsatisfiable" });
    expect(parseRange("bytes=5-2", 100)).toEqual({ kind: "none" });
    expect(parseRange("bytes=0-1,5-6", 100)).toEqual({ kind: "none" });
    expect(parseRange("items=0-1", 100)).toEqual({ kind: "none" });
    expect(parseRange("bytes=-", 100)).toEqual({ kind: "none" });
    expect(parseRange("bytes=a-b", 100)).toEqual({ kind: "none" });
  });
});
