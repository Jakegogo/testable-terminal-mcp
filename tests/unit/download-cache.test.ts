/**
 * Unit tests for download-cache + URL resolution.
 *
 * Cache uses real fs (mkdtemp under tmp); URL resolver is pure.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DownloadCache, defaultCacheDir, pickArchiveExt } from "../../src/core/download-cache/cache.js";
import { resolveDownloadUrl } from "../../src/core/download-cache/installers.js";
import { ErrorCode, isTestableTerminalError } from "../../src/core/errors.js";
import { inferPlatform } from "../../src/core/platform.js";

let cacheDir: string;
let stagingDir: string;
beforeEach(() => {
  cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "ttm-cache-test-"));
  stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), "ttm-cache-staging-"));
});
afterEach(() => {
  fs.rmSync(cacheDir, { recursive: true, force: true });
  fs.rmSync(stagingDir, { recursive: true, force: true });
});

const writeBlob = (size: number, name = "blob.tar.gz"): string => {
  const p = path.join(stagingDir, name);
  fs.writeFileSync(p, Buffer.alloc(size, "X"));
  return p;
};

describe("DownloadCache — basic put/get", () => {
  it("starts empty", () => {
    const c = new DownloadCache({ cacheDir, maxBytes: 1_000_000 });
    expect(c.list()).toEqual([]);
    expect(c.totalBytes()).toBe(0);
    expect(c.get("claude", "v1")).toBe(null);
  });

  it("put copies into cache and indexes the entry", () => {
    const c = new DownloadCache({ cacheDir, maxBytes: 1_000_000 });
    const src = writeBlob(100);
    const e = c.put({ tool: "claude", version: "v1", tarballSource: src, sha256: "abc123" });
    expect(e.tool).toBe("claude");
    expect(e.version).toBe("v1");
    expect(e.sha256).toBe("abc123");
    expect(e.size).toBe(100);
    expect(fs.existsSync(e.tarball)).toBe(true);
    expect(e.tarball.startsWith(cacheDir)).toBe(true);
    expect(e.tarball.endsWith(".tar.gz")).toBe(true);
    // Source moved (not copied) — staging path no longer exists.
    expect(fs.existsSync(src)).toBe(false);
  });

  it("get returns the stored entry and updates lastUsedAt", async () => {
    const c = new DownloadCache({ cacheDir, maxBytes: 1_000_000 });
    const src = writeBlob(50);
    const inserted = c.put({ tool: "claude", version: "v1", tarballSource: src, sha256: "h" });
    // Sleep 5ms so the second now() yields a strictly later ISO.
    await new Promise((r) => setTimeout(r, 5));
    const got = c.get("claude", "v1");
    expect(got).not.toBeNull();
    expect(got!.tarball).toBe(inserted.tarball);
    expect(got!.lastUsedAt >= inserted.lastUsedAt).toBe(true);
  });

  it("get heals stale index entries (file deleted out from under cache)", () => {
    const c = new DownloadCache({ cacheDir, maxBytes: 1_000_000 });
    const e = c.put({ tool: "claude", version: "v1", tarballSource: writeBlob(10), sha256: "h" });
    fs.unlinkSync(e.tarball);
    expect(c.get("claude", "v1")).toBe(null);
    // Index also cleaned.
    expect(c.list()).toEqual([]);
  });

  it("delete removes file + index entry", () => {
    const c = new DownloadCache({ cacheDir, maxBytes: 1_000_000 });
    const e = c.put({ tool: "claude", version: "v1", tarballSource: writeBlob(10), sha256: "h" });
    c.delete("claude", "v1");
    expect(fs.existsSync(e.tarball)).toBe(false);
    expect(c.get("claude", "v1")).toBe(null);
  });

  it("missing source throws E_TT_VERSION_DOWNLOAD_FAILED", () => {
    const c = new DownloadCache({ cacheDir, maxBytes: 1_000_000 });
    try {
      c.put({ tool: "claude", version: "v1", tarballSource: "/no/such/path.tar.gz", sha256: "h" });
      expect.fail("should have thrown");
    } catch (err) {
      expect(isTestableTerminalError(err)).toBe(true);
      if (isTestableTerminalError(err)) {
        expect(err.code).toBe(ErrorCode.VERSION_DOWNLOAD_FAILED);
      }
    }
  });

  it("rejects index.json corruption gracefully (rebuilds empty)", () => {
    const c = new DownloadCache({ cacheDir, maxBytes: 1_000_000 });
    fs.writeFileSync(path.join(cacheDir, "index.json"), "not json {{");
    expect(c.list()).toEqual([]); // doesn't throw
    // Subsequent put still works.
    const e = c.put({ tool: "claude", version: "v1", tarballSource: writeBlob(5), sha256: "h" });
    expect(c.get("claude", "v1")?.tarball).toBe(e.tarball);
  });
});

describe("DownloadCache — LRU eviction", () => {
  it("evicts oldest when totalBytes exceeds maxBytes", async () => {
    const c = new DownloadCache({ cacheDir, maxBytes: 250 });
    c.put({ tool: "t", version: "v1", tarballSource: writeBlob(100, "a.tar.gz"), sha256: "h1" });
    await new Promise((r) => setTimeout(r, 5));
    c.put({ tool: "t", version: "v2", tarballSource: writeBlob(100, "b.tar.gz"), sha256: "h2" });
    await new Promise((r) => setTimeout(r, 5));
    // 200/250 used. Add 100 → 300 > 250 → evict v1 (oldest).
    c.put({ tool: "t", version: "v3", tarballSource: writeBlob(100, "c.tar.gz"), sha256: "h3" });

    expect(c.get("t", "v1")).toBe(null);
    expect(c.get("t", "v2")).not.toBeNull();
    expect(c.get("t", "v3")).not.toBeNull();
  });

  it("never evicts the just-inserted entry", () => {
    const c = new DownloadCache({ cacheDir, maxBytes: 100 });
    // First put: 200 > 100 cap. The just-added entry must survive even though
    // we're already over cap (it's "protected" — caller will retry on next
    // put). Older entries get cleared first.
    const e = c.put({ tool: "t", version: "v1", tarballSource: writeBlob(200, "big.tar.gz"), sha256: "h" });
    expect(fs.existsSync(e.tarball)).toBe(true);
    expect(c.get("t", "v1")).not.toBeNull();
  });
});

describe("defaultCacheDir / pickArchiveExt", () => {
  it("POSIX default points under XDG_CACHE_HOME or ~/.cache", () => {
    const dir = defaultCacheDir(inferPlatform("darwin", "arm64"));
    expect(dir.endsWith("/ttm/downloads")).toBe(true);
  });

  it("Windows default points under LOCALAPPDATA/ttm/Cache/downloads", () => {
    const dir = defaultCacheDir(inferPlatform("win32", "x64"));
    expect(dir.endsWith("/ttm/Cache/downloads") || dir.endsWith("\\ttm\\Cache\\downloads")).toBe(true);
  });

  it("pickArchiveExt distinguishes .tar.gz / .tgz / .zip / .tar.xz", () => {
    expect(pickArchiveExt("/x/foo.tar.gz")).toBe(".tar.gz");
    expect(pickArchiveExt("/x/foo.tgz")).toBe(".tar.gz");
    expect(pickArchiveExt("/x/foo.tar.xz")).toBe(".tar.xz");
    expect(pickArchiveExt("/x/foo.txz")).toBe(".tar.xz");
    expect(pickArchiveExt("/x/foo.zip")).toBe(".zip");
    expect(pickArchiveExt("/x/foo.bin")).toBe(".bin");
    expect(pickArchiveExt("/x/foo")).toBe("");
  });
});

describe("resolveDownloadUrl", () => {
  const POSIX = inferPlatform("darwin", "arm64");
  const sources = {
    claude: {
      "darwin-arm64": "file:///fixtures/{tool}-{version}-{platform}-{arch}.tar.gz",
      "linux": "file:///fixtures/{tool}-{version}-linux.tar.gz",
      "default": "file:///fixtures/{tool}-{version}.tar.gz",
    },
  };

  it("substitutes placeholders with platform-arch key", () => {
    const url = resolveDownloadUrl({ tool: "claude", version: "v1", platform: POSIX, sources });
    expect(url).toBe("file:///fixtures/claude-v1-darwin-arm64.tar.gz");
  });

  it("falls back to platform-only key when arch-specific missing", () => {
    const linuxArm = inferPlatform("linux", "arm64");
    const url = resolveDownloadUrl({ tool: "claude", version: "v2", platform: linuxArm, sources });
    expect(url).toBe("file:///fixtures/claude-v2-linux.tar.gz");
  });

  it("falls back to default key when neither present", () => {
    const win = inferPlatform("win32", "x64");
    const url = resolveDownloadUrl({ tool: "claude", version: "v3", platform: win, sources });
    expect(url).toBe("file:///fixtures/claude-v3.tar.gz");
  });

  it("throws E_TT_VERSION_NOT_FOUND when tool unknown", () => {
    try {
      resolveDownloadUrl({ tool: "missing", version: "v1", platform: POSIX, sources });
      expect.fail("should have thrown");
    } catch (err) {
      expect(isTestableTerminalError(err)).toBe(true);
      if (isTestableTerminalError(err)) expect(err.code).toBe(ErrorCode.VERSION_NOT_FOUND);
    }
  });

  it("throws E_TT_VERSION_NOT_FOUND when no platform-arch / platform / default match", () => {
    try {
      resolveDownloadUrl({ tool: "claude", version: "v1", platform: POSIX, sources: { claude: { "freebsd-x64": "x" } } });
      expect.fail("should have thrown");
    } catch (err) {
      expect(isTestableTerminalError(err)).toBe(true);
      if (isTestableTerminalError(err)) expect(err.code).toBe(ErrorCode.VERSION_NOT_FOUND);
    }
  });
});
