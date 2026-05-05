/**
 * M5a acceptance #2 — small cacheMaxBytes triggers LRU eviction; index.json
 * stays consistent throughout.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createSandbox, __resetForTests as resetMgr } from "../../src/core/sandbox/manager.js";
import { DownloadCache } from "../../src/core/download-cache/cache.js";
import { installVersion } from "../../src/core/download-cache/installers.js";
import { buildStubTarball } from "../fixtures/builders/stub-binary.js";
import { platform as hostPlatform } from "../../src/core/platform.js";

const TIMEOUT = 20_000;

let cacheDir: string;
let fixtureDir: string;
let downloadSources: Record<string, Record<string, string>>;

beforeEach(() => {
  cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "ttm-lru-cache-"));
  fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "ttm-lru-fixtures-"));

  buildStubTarball({ name: "claude", version: "v1", outDir: fixtureDir, filename: "claude-v1.tar.gz" });
  buildStubTarball({ name: "claude", version: "v2", outDir: fixtureDir, filename: "claude-v2.tar.gz" });
  buildStubTarball({ name: "claude", version: "v3", outDir: fixtureDir, filename: "claude-v3.tar.gz" });

  downloadSources = {
    claude: { default: `file://${fixtureDir}/claude-{version}.tar.gz` },
  };
});
afterEach(() => {
  resetMgr();
  fs.rmSync(cacheDir, { recursive: true, force: true });
  fs.rmSync(fixtureDir, { recursive: true, force: true });
});

describe("sandbox integration — cache LRU", () => {
  it("third install evicts the oldest; index.json + on-disk stay consistent", async () => {
    if (hostPlatform.isWindows) return;

    // Pick a maxBytes just under 2× the tarball size so the third install
    // forces eviction of the oldest entry.
    const tarballSize = fs.statSync(path.join(fixtureDir, "claude-v1.tar.gz")).size;
    const cache = new DownloadCache({ cacheDir, maxBytes: Math.floor(tarballSize * 2.5) });

    const sbx = createSandbox({ config: { mode: "ephemeral" }, manager: { maxConcurrentSandboxes: 4, skipSignalHooks: true } });

    await installVersion({ sandbox: sbx, tool: "claude", version: "v1", downloadSources, cache });
    await new Promise((r) => setTimeout(r, 5));
    await installVersion({ sandbox: sbx, tool: "claude", version: "v2", downloadSources, cache });
    await new Promise((r) => setTimeout(r, 5));
    await installVersion({ sandbox: sbx, tool: "claude", version: "v3", downloadSources, cache });

    // v1 is oldest → evicted; v2 + v3 retained.
    expect(cache.get("claude", "v1")).toBe(null);
    expect(cache.get("claude", "v2")).not.toBeNull();
    expect(cache.get("claude", "v3")).not.toBeNull();

    // index.json and on-disk tarballs match.
    const idx = JSON.parse(fs.readFileSync(path.join(cacheDir, "index.json"), "utf8"));
    expect(idx.claude?.v1).toBeUndefined();
    expect(idx.claude?.v2?.tarball).toMatch(/claude-v2\.tar\.gz$/);
    expect(idx.claude?.v3?.tarball).toMatch(/claude-v3\.tar\.gz$/);
    expect(fs.existsSync(idx.claude.v2.tarball)).toBe(true);
    expect(fs.existsSync(idx.claude.v3.tarball)).toBe(true);
    // No leftover v1 file under cacheDir.
    const files = fs.readdirSync(cacheDir);
    expect(files.find((f) => f === "claude-v1.tar.gz")).toBeUndefined();

    // Total bytes within budget.
    expect(cache.totalBytes()).toBeLessThanOrEqual(cache.maxBytes);
  }, TIMEOUT);

  it("touching v1 (get) before installing v3 evicts v2 instead", async () => {
    if (hostPlatform.isWindows) return;

    const tarballSize = fs.statSync(path.join(fixtureDir, "claude-v1.tar.gz")).size;
    const cache = new DownloadCache({ cacheDir, maxBytes: Math.floor(tarballSize * 2.5) });
    const sbx = createSandbox({ config: { mode: "ephemeral" }, manager: { maxConcurrentSandboxes: 4, skipSignalHooks: true } });

    await installVersion({ sandbox: sbx, tool: "claude", version: "v1", downloadSources, cache });
    await new Promise((r) => setTimeout(r, 5));
    await installVersion({ sandbox: sbx, tool: "claude", version: "v2", downloadSources, cache });
    await new Promise((r) => setTimeout(r, 5));
    // Touch v1 — now v2 is the oldest by lastUsedAt.
    expect(cache.get("claude", "v1")).not.toBeNull();
    await new Promise((r) => setTimeout(r, 5));
    await installVersion({ sandbox: sbx, tool: "claude", version: "v3", downloadSources, cache });

    expect(cache.get("claude", "v1")).not.toBeNull(); // retained, just touched
    expect(cache.get("claude", "v2")).toBe(null);     // evicted
    expect(cache.get("claude", "v3")).not.toBeNull();
  }, TIMEOUT);
});
