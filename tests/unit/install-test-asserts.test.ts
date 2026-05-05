/**
 * Unit tests for the 5 assert tools — pure functions on synthetic data.
 *
 * Integration smoke (live shell + real installers) lives in
 * tests/integration-install-test/.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { assertEnvNoPathDuplicates } from "../../src/core/install-test/asserts/env-no-path-duplicates.js";
import { assertEnvDiff, computeChanges } from "../../src/core/install-test/asserts/env-diff.js";
import { assertFileUnchanged } from "../../src/core/install-test/asserts/file-unchanged.js";
import {
  assertMonitoredPathsUnchanged, snapshotMonitoredPaths,
} from "../../src/core/install-test/asserts/monitored-paths-unchanged.js";
import { hashFile, autoBaseline } from "../../src/core/install-test/file-baseline.js";
import { ErrorCode, isTestableTerminalError } from "../../src/core/errors.js";
import { inferPlatform } from "../../src/core/platform.js";
import type { EnvSnapshot, FileBaseline, SandboxRef } from "../../src/core/types.js";

const POSIX = inferPlatform("darwin", "arm64");
const WIN = inferPlatform("win32", "x64");

const snap = (name: string, env: Record<string, string>, mode: "current" | "fresh-login" = "fresh-login"): EnvSnapshot => ({
  name, mode, env, capturedAt: "2026-05-04T10:00:00.000Z",
});

const sbx = (p: string): SandboxRef => ({ id: "sbx_test", path: p, mode: "ephemeral", profile: "minimal", createdAt: new Date() });

describe("assertEnvNoPathDuplicates", () => {
  it("passes when PATH has no dups", () => {
    expect(() => assertEnvNoPathDuplicates({
      snapshot: snap("s", { PATH: "/usr/bin:/bin:/sbin" }),
      platform: POSIX,
    })).not.toThrow();
  });

  it("flags duplicate dirs", () => {
    try {
      assertEnvNoPathDuplicates({
        snapshot: snap("s", { PATH: "/dup/bin:/usr/bin:/dup/bin:/bin" }),
        platform: POSIX,
      });
      expect.fail("should have thrown");
    } catch (err) {
      expect(isTestableTerminalError(err)).toBe(true);
      if (isTestableTerminalError(err)) {
        expect(err.code).toBe(ErrorCode.ASSERT_PATH_DUPLICATES);
        expect((err.details as { duplicates: { dir: string; count: number }[] }).duplicates).toEqual([
          { dir: "/dup/bin", count: 2 },
        ]);
      }
    }
  });

  it("Windows is case-insensitive (Path mirror also honored)", () => {
    try {
      assertEnvNoPathDuplicates({
        snapshot: snap("s", { Path: "C:\\X\\bin;C:\\Y;c:\\x\\bin" }),
        platform: WIN,
      });
      expect.fail("should have thrown");
    } catch (err) {
      expect(isTestableTerminalError(err)).toBe(true);
      if (isTestableTerminalError(err)) {
        expect((err.details as { duplicates: { dir: string }[] }).duplicates[0]!.dir).toBe("C:\\X\\bin");
      }
    }
  });
});

describe("assertEnvDiff / computeChanges", () => {
  it("classifies add / remove / modify", () => {
    const c = computeChanges({ A: "1", B: "2" }, { A: "1", C: "3" }, POSIX);
    expect(c).toContainEqual({ key: "B", op: "remove", from: "2" });
    expect(c).toContainEqual({ key: "C", op: "add", to: "3" });
    expect(c.find((x) => x.key === "A")).toBeUndefined();
  });

  it("refines PATH modify into prepend when value extends with sandbox bin", () => {
    const c = computeChanges(
      { PATH: "/usr/bin:/bin" },
      { PATH: "/sbx/bin:/usr/bin:/bin" },
      POSIX,
    );
    expect(c).toContainEqual({ key: "PATH", op: "prepend", from: "/usr/bin:/bin", to: "/sbx/bin:/usr/bin:/bin" });
  });

  it("refines PATH modify into append when value ends with sep+old", () => {
    const c = computeChanges(
      { PATH: "/usr/bin:/bin" },
      { PATH: "/usr/bin:/bin:/sbx/extra" },
      POSIX,
    );
    expect(c.find((x) => x.key === "PATH" && x.op === "append")).not.toBeUndefined();
  });

  it("allowedChanges whitelist accepts matching changes; throws on the rest", () => {
    const before = snap("b", { PATH: "/bin", FOO: "1" });
    const after = snap("a", { PATH: "/sbx/bin:/bin", FOO: "1", NEW: "x" });
    // Only PATH prepend is allowed; NEW addition is unexpected.
    try {
      assertEnvDiff({
        before, after,
        allowedChanges: [{ key: "PATH", op: "prepend" }],
      });
      expect.fail("should have thrown");
    } catch (err) {
      expect(isTestableTerminalError(err)).toBe(true);
      if (isTestableTerminalError(err)) {
        expect(err.code).toBe(ErrorCode.ASSERT_ENV_DIFF);
        const unexpected = (err.details as { unexpected: { key: string }[] }).unexpected;
        expect(unexpected.find((u) => u.key === "NEW")).not.toBeUndefined();
      }
    }
  });

  it("allowedChanges modify matches prepend / append refinements", () => {
    const before = snap("b", { PATH: "/bin" });
    const after = snap("a", { PATH: "/new:/bin" });
    expect(() => assertEnvDiff({
      before, after,
      allowedChanges: [{ key: "PATH", op: "modify" }],
    })).not.toThrow();
  });

  it("valuePattern regex anchors against full value", () => {
    const before = snap("b", { TOKEN: "" });
    const after = snap("a", { TOKEN: "abc-123" });
    expect(() => assertEnvDiff({
      before, after,
      allowedChanges: [{ key: "TOKEN", op: "modify", valuePattern: "abc-\\d+" }],
    })).not.toThrow();
    expect(() => assertEnvDiff({
      before, after,
      allowedChanges: [{ key: "TOKEN", op: "modify", valuePattern: "xyz-\\d+" }],
    })).toThrow();
  });
});

describe("assertFileUnchanged + file-baseline", () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "ttm-fu-")); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it("autoBaseline records absent files as null sha256", () => {
    fs.mkdirSync(path.join(dir, ".aikey"), { recursive: true });
    const baselines = autoBaseline({ sandbox: sbx(dir) });
    const bashrc = baselines.find((b) => b.path === ".bashrc")!;
    expect(bashrc.sha256).toBe(null);
    expect(bashrc.size).toBe(null);
  });

  it("hashFile records sha256 + size for present files", () => {
    fs.writeFileSync(path.join(dir, ".bashrc"), "hello\n");
    const b = hashFile({ id: "test", path: ".bashrc", absolutePath: path.join(dir, ".bashrc") });
    expect(b.sha256).toBe("5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03");
    expect(b.size).toBe(6);
  });

  it("passes when content unchanged", () => {
    fs.writeFileSync(path.join(dir, ".bashrc"), "stable\n");
    const baselines: FileBaseline[] = [hashFile({ id: "x", path: ".bashrc", absolutePath: path.join(dir, ".bashrc") })];
    expect(() => assertFileUnchanged({ sandbox: sbx(dir), path: ".bashrc", baselines })).not.toThrow();
  });

  it("throws ASSERT_FILE_CHANGED with diff when content changed", () => {
    fs.writeFileSync(path.join(dir, ".bashrc"), "before\n");
    const baselines: FileBaseline[] = [hashFile({ id: "x", path: ".bashrc", absolutePath: path.join(dir, ".bashrc") })];
    fs.writeFileSync(path.join(dir, ".bashrc"), "after\n");
    try {
      assertFileUnchanged({ sandbox: sbx(dir), path: ".bashrc", baselines });
      expect.fail("should have thrown");
    } catch (err) {
      expect(isTestableTerminalError(err)).toBe(true);
      if (isTestableTerminalError(err)) {
        expect(err.code).toBe(ErrorCode.ASSERT_FILE_CHANGED);
        const diff = (err.details as { diff: string }).diff;
        expect(diff).toContain("-before");
        expect(diff).toContain("+after");
      }
    }
  });

  it("throws when file absent at baseline but appeared after", () => {
    const baselines: FileBaseline[] = [hashFile({
      id: "x", path: ".new",
      absolutePath: path.join(dir, ".new"),
    })];
    fs.writeFileSync(path.join(dir, ".new"), "appeared\n");
    try {
      assertFileUnchanged({ sandbox: sbx(dir), path: ".new", baselines });
      expect.fail("should have thrown");
    } catch (err) {
      if (isTestableTerminalError(err)) {
        expect((err.details as { diff: string }).diff).toContain("new file appeared");
      }
    }
  });

  it("explicit baselineId selects an older baseline over newer", () => {
    fs.writeFileSync(path.join(dir, ".rc"), "v1\n");
    const old = hashFile({ id: "old", path: ".rc", absolutePath: path.join(dir, ".rc") });
    fs.writeFileSync(path.join(dir, ".rc"), "v2\n");
    const newer = hashFile({ id: "newer", path: ".rc", absolutePath: path.join(dir, ".rc") });
    // Asserting against id=old should fail (v1 → v2 changed).
    expect(() => assertFileUnchanged({
      sandbox: sbx(dir), path: ".rc", baselines: [old, newer], baselineId: "old",
    })).toThrow();
    // Asserting against id=newer (current state) should pass.
    expect(() => assertFileUnchanged({
      sandbox: sbx(dir), path: ".rc", baselines: [old, newer], baselineId: "newer",
    })).not.toThrow();
  });
});

describe("monitored-paths-unchanged", () => {
  let dir: string;
  let target: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ttm-mon-"));
    target = path.join(dir, "leak-target.txt");
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it("passes when nothing changed", () => {
    fs.writeFileSync(target, "stable");
    const before = snapshotMonitoredPaths([target]);
    const after = snapshotMonitoredPaths([target]);
    expect(() => assertMonitoredPathsUnchanged({ before, after })).not.toThrow();
  });

  it("flags 'modified' when file content changed", () => {
    fs.writeFileSync(target, "v1");
    const before = snapshotMonitoredPaths([target]);
    fs.writeFileSync(target, "v2-different");
    const after = snapshotMonitoredPaths([target]);
    try {
      assertMonitoredPathsUnchanged({ before, after });
      expect.fail("should have thrown");
    } catch (err) {
      expect(isTestableTerminalError(err)).toBe(true);
      if (isTestableTerminalError(err)) {
        expect(err.code).toBe(ErrorCode.ASSERT_OUTSIDE_LEAK);
        const leaks = (err.details as { leaks: { path: string; op: string }[] }).leaks;
        expect(leaks[0]!.op).toBe("modified");
      }
    }
  });

  it("flags 'added' when file appears", () => {
    const before = snapshotMonitoredPaths([target]);  // absent
    fs.writeFileSync(target, "new");
    const after = snapshotMonitoredPaths([target]);
    try {
      assertMonitoredPathsUnchanged({ before, after });
      expect.fail("should have thrown");
    } catch (err) {
      if (isTestableTerminalError(err)) {
        expect((err.details as { leaks: { op: string }[] }).leaks[0]!.op).toBe("added");
      }
    }
  });

  it("flags 'removed' when file disappears", () => {
    fs.writeFileSync(target, "x");
    const before = snapshotMonitoredPaths([target]);
    fs.unlinkSync(target);
    const after = snapshotMonitoredPaths([target]);
    try {
      assertMonitoredPathsUnchanged({ before, after });
      expect.fail("should have thrown");
    } catch (err) {
      if (isTestableTerminalError(err)) {
        expect((err.details as { leaks: { op: string }[] }).leaks[0]!.op).toBe("removed");
      }
    }
  });

  it("dir hash detects child changes", () => {
    const sub = path.join(dir, "sub");
    fs.mkdirSync(sub);
    fs.writeFileSync(path.join(sub, "a"), "a");
    const before = snapshotMonitoredPaths([sub]);
    fs.writeFileSync(path.join(sub, "b"), "b");  // new child
    const after = snapshotMonitoredPaths([sub]);
    try {
      assertMonitoredPathsUnchanged({ before, after });
      expect.fail("should have thrown");
    } catch (err) {
      if (isTestableTerminalError(err)) {
        const leaks = (err.details as { leaks: { op: string; snippet?: string }[] }).leaks;
        expect(leaks[0]!.snippet).toContain("directory");
      }
    }
  });
});
