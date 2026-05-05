/**
 * M5a acceptance #1 — install two versions of a stub tool, run each in its
 * own sandbox session, assert the in-shell `--version` output differs.
 *
 * Builds fixture stub tarballs at test setup time (no checked-in binary
 * blobs). Uses file:// URL so the install path is fully self-contained.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { startSession } from "../../src/core/terminal-session.js";
import { createSandbox, __resetForTests as resetMgr } from "../../src/core/sandbox/manager.js";
import { __resetForTests as resetCleanup } from "../../src/core/process-cleanup.js";
import { DownloadCache } from "../../src/core/download-cache/cache.js";
import { installVersion } from "../../src/core/download-cache/installers.js";
import { buildStubTarball } from "../fixtures/builders/stub-binary.js";
import { platform as hostPlatform } from "../../src/core/platform.js";

afterAll(() => { resetCleanup(); });

const TIMEOUT = 20_000;

let cacheDir: string;
let fixtureDir: string;
let downloadSources: Record<string, Record<string, string>>;

beforeEach(() => {
  cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "ttm-m5a-cache-"));
  fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "ttm-m5a-fixtures-"));

  // Build three stub tarballs at known paths.
  buildStubTarball({ name: "claude", version: "v1", outDir: fixtureDir, filename: "claude-v1.tar.gz" });
  buildStubTarball({ name: "claude", version: "v2", outDir: fixtureDir, filename: "claude-v2.tar.gz" });
  buildStubTarball({ name: "kimi",   version: "v1", outDir: fixtureDir, filename: "kimi-v1.tar.gz" });

  // file:// URL templates that point at the fixtures we just built.
  downloadSources = {
    claude: { default: `file://${fixtureDir}/claude-{version}.tar.gz` },
    kimi:   { default: `file://${fixtureDir}/kimi-{version}.tar.gz` },
  };
});
afterEach(() => {
  resetMgr();
  fs.rmSync(cacheDir, { recursive: true, force: true });
  fs.rmSync(fixtureDir, { recursive: true, force: true });
});

describe("sandbox integration — multi-version install", () => {
  it("installs claude v1 + v2 into separate sandboxes; in-shell --version differs", async () => {
    if (hostPlatform.isWindows) return; // POSIX-only fixture tarballs

    const cache = new DownloadCache({ cacheDir, maxBytes: 1_000_000 });
    const sbxA = createSandbox({ config: { mode: "ephemeral" }, manager: { maxConcurrentSandboxes: 4, skipSignalHooks: true } });
    const sbxB = createSandbox({ config: { mode: "ephemeral" }, manager: { maxConcurrentSandboxes: 4, skipSignalHooks: true } });

    const a = await installVersion({ sandbox: sbxA, tool: "claude", version: "v1", downloadSources, cache });
    const b = await installVersion({ sandbox: sbxB, tool: "claude", version: "v2", downloadSources, cache });

    expect(a.binaryPath).toBe(path.join(sbxA.path, ".local/bin/claude"));
    expect(b.binaryPath).toBe(path.join(sbxB.path, ".local/bin/claude"));
    // Distinct sandboxes hold distinct binaries.
    expect(a.binaryPath).not.toBe(b.binaryPath);

    // In-shell verification: PATH-resolved `claude --version` differs.
    const sa = await startSession({ command: "bash", sandbox: sbxA });
    const sb = await startSession({ command: "bash", sandbox: sbxB });
    try {
      await sa.waitForRegex(/\$\s/, { timeoutMs: 3_000 });
      await sb.waitForRegex(/\$\s/, { timeoutMs: 3_000 });
      sa.write("claude --version\n");
      sb.write("claude --version\n");
      await sa.waitForRegex(/claude v1\b/, { timeoutMs: 3_000 });
      await sb.waitForRegex(/claude v2\b/, { timeoutMs: 3_000 });
    } finally {
      await Promise.all([sa.close(), sb.close()]);
    }
  }, TIMEOUT);

  it("second install of the same version is a cache hit (no re-fetch)", async () => {
    if (hostPlatform.isWindows) return;

    const cache = new DownloadCache({ cacheDir, maxBytes: 1_000_000 });
    const sbxA = createSandbox({ config: { mode: "ephemeral" }, manager: { maxConcurrentSandboxes: 4, skipSignalHooks: true } });
    const sbxB = createSandbox({ config: { mode: "ephemeral" }, manager: { maxConcurrentSandboxes: 4, skipSignalHooks: true } });

    const r1 = await installVersion({ sandbox: sbxA, tool: "claude", version: "v1", downloadSources, cache });
    const r2 = await installVersion({ sandbox: sbxB, tool: "claude", version: "v1", downloadSources, cache });
    expect(r1.cacheHit).toBe(false);
    expect(r2.cacheHit).toBe(true);
    expect(r1.tarball).toBe(r2.tarball); // same cached file reused
  }, TIMEOUT);

  it("checksum mismatch surfaces E_TT_VERSION_CHECKSUM_MISMATCH", async () => {
    if (hostPlatform.isWindows) return;

    const cache = new DownloadCache({ cacheDir, maxBytes: 1_000_000 });
    const sbx = createSandbox({ config: { mode: "ephemeral" }, manager: { maxConcurrentSandboxes: 4, skipSignalHooks: true } });

    try {
      await installVersion({
        sandbox: sbx, tool: "claude", version: "v1",
        downloadSources, cache,
        expectedSha256: "0".repeat(64), // wrong
      });
      expect.fail("should have thrown");
    } catch (err) {
      const e = err as { code?: string };
      expect(e.code).toBe("E_TT_VERSION_CHECKSUM_MISMATCH");
    }
  }, TIMEOUT);

  it("unknown tool surfaces E_TT_VERSION_NOT_FOUND", async () => {
    if (hostPlatform.isWindows) return;

    const cache = new DownloadCache({ cacheDir, maxBytes: 1_000_000 });
    const sbx = createSandbox({ config: { mode: "ephemeral" }, manager: { maxConcurrentSandboxes: 4, skipSignalHooks: true } });

    try {
      await installVersion({ sandbox: sbx, tool: "no-such", version: "v1", downloadSources, cache });
      expect.fail("should have thrown");
    } catch (err) {
      const e = err as { code?: string };
      expect(e.code).toBe("E_TT_VERSION_NOT_FOUND");
    }
  }, TIMEOUT);
});
