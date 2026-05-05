/**
 * Unit tests for sandbox manager (lifecycle + registry + limits).
 *
 * Uses real fs (mkdtemp + rm -rf), no PTY. Each test resets the registry
 * via __resetForTests() to avoid leaks between tests.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  createSandbox, destroySandbox, cleanupEphemeral,
  getSandbox, listSandboxes, sandboxCount,
  __resetForTests,
} from "../../src/core/sandbox/manager.js";
import { ErrorCode, isTestableTerminalError } from "../../src/core/errors.js";

let rootDir: string;
beforeEach(() => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ttm-mgr-test-"));
});
afterEach(() => {
  __resetForTests();
  fs.rmSync(rootDir, { recursive: true, force: true });
});

describe("sandbox manager — create ephemeral", () => {
  it("mkdtemps under rootDir + returns ref with valid id/path/mode/profile", () => {
    const ref = createSandbox({
      config: { mode: "ephemeral", profile: "minimal" },
      manager: { maxConcurrentSandboxes: 4, rootDir, skipSignalHooks: true },
    });
    expect(ref.id).toMatch(/^sbx_/);
    expect(ref.mode).toBe("ephemeral");
    expect(ref.profile).toBe("minimal");
    expect(fs.existsSync(ref.path)).toBe(true);
    expect(ref.path.startsWith(rootDir)).toBe(true);
    // Standard tree is in place from applyProfile.
    expect(fs.existsSync(path.join(ref.path, "bin"))).toBe(true);
    expect(fs.existsSync(path.join(ref.path, "_meta.json"))).toBe(true);
  });

  it("two sandboxes get distinct paths and ids", () => {
    const a = createSandbox({
      config: { mode: "ephemeral" },
      manager: { maxConcurrentSandboxes: 4, rootDir, skipSignalHooks: true },
    });
    const b = createSandbox({
      config: { mode: "ephemeral" },
      manager: { maxConcurrentSandboxes: 4, rootDir, skipSignalHooks: true },
    });
    expect(a.id).not.toBe(b.id);
    expect(a.path).not.toBe(b.path);
  });

  it("seed.files writes through during create", () => {
    const ref = createSandbox({
      config: {
        mode: "ephemeral",
        seed: { files: { ".zshrc": "export FROMSEED=1\n" } },
      },
      manager: { maxConcurrentSandboxes: 4, rootDir, skipSignalHooks: true },
    });
    expect(fs.readFileSync(path.join(ref.path, ".zshrc"), "utf8")).toBe("export FROMSEED=1\n");
  });
});

describe("sandbox manager — create persistent", () => {
  it("uses caller-provided path; does not delete on destroy", () => {
    const persistPath = path.join(rootDir, "persistent");
    const ref = createSandbox({
      config: { mode: "persistent", path: persistPath },
      manager: { maxConcurrentSandboxes: 4, rootDir, skipSignalHooks: true },
    });
    expect(ref.path).toBe(persistPath);
    expect(fs.existsSync(persistPath)).toBe(true);

    destroySandbox(ref.id);
    expect(fs.existsSync(persistPath)).toBe(true); // persistent path retained
    expect(getSandbox(ref.id)).toBe(null);
  });

  it("persistent without path throws E_TT_INVALID_INPUT", () => {
    try {
      createSandbox({
        config: { mode: "persistent" },
        manager: { maxConcurrentSandboxes: 4, rootDir, skipSignalHooks: true },
      });
      expect.fail("should have thrown");
    } catch (err) {
      expect(isTestableTerminalError(err)).toBe(true);
      if (isTestableTerminalError(err)) {
        expect(err.code).toBe(ErrorCode.INVALID_INPUT);
      }
    }
  });
});

describe("sandbox manager — destroy + cleanup", () => {
  it("destroy ephemeral rm -rf the sandbox dir", () => {
    const ref = createSandbox({
      config: { mode: "ephemeral" },
      manager: { maxConcurrentSandboxes: 4, rootDir, skipSignalHooks: true },
    });
    expect(fs.existsSync(ref.path)).toBe(true);
    destroySandbox(ref.id);
    expect(fs.existsSync(ref.path)).toBe(false);
    expect(getSandbox(ref.id)).toBe(null);
  });

  it("destroy unknown id is a no-op (warn only)", () => {
    expect(() => destroySandbox("sbx_no_such")).not.toThrow();
  });

  it("cleanupEphemeral destroys all ephemeral, leaves persistent", () => {
    const e1 = createSandbox({
      config: { mode: "ephemeral" },
      manager: { maxConcurrentSandboxes: 4, rootDir, skipSignalHooks: true },
    });
    const e2 = createSandbox({
      config: { mode: "ephemeral" },
      manager: { maxConcurrentSandboxes: 4, rootDir, skipSignalHooks: true },
    });
    const persistPath = path.join(rootDir, "p1");
    const p1 = createSandbox({
      config: { mode: "persistent", path: persistPath },
      manager: { maxConcurrentSandboxes: 4, rootDir, skipSignalHooks: true },
    });

    expect(sandboxCount()).toBe(3);
    const n = cleanupEphemeral();
    expect(n).toBe(2);
    expect(sandboxCount()).toBe(1);
    expect(getSandbox(p1.id)).not.toBe(null);
    expect(fs.existsSync(e1.path)).toBe(false);
    expect(fs.existsSync(e2.path)).toBe(false);
    expect(fs.existsSync(persistPath)).toBe(true);
  });
});

describe("sandbox manager — limits", () => {
  it("creating beyond maxConcurrentSandboxes throws E_TT_SANDBOX_LIMIT", () => {
    createSandbox({
      config: { mode: "ephemeral" },
      manager: { maxConcurrentSandboxes: 2, rootDir, skipSignalHooks: true },
    });
    createSandbox({
      config: { mode: "ephemeral" },
      manager: { maxConcurrentSandboxes: 2, rootDir, skipSignalHooks: true },
    });
    try {
      createSandbox({
        config: { mode: "ephemeral" },
        manager: { maxConcurrentSandboxes: 2, rootDir, skipSignalHooks: true },
      });
      expect.fail("should have thrown");
    } catch (err) {
      expect(isTestableTerminalError(err)).toBe(true);
      if (isTestableTerminalError(err)) {
        expect(err.code).toBe(ErrorCode.SANDBOX_LIMIT);
      }
    }
  });

  it("after destroy, slot frees up so a new create succeeds", () => {
    const a = createSandbox({
      config: { mode: "ephemeral" },
      manager: { maxConcurrentSandboxes: 1, rootDir, skipSignalHooks: true },
    });
    expect(sandboxCount()).toBe(1);
    destroySandbox(a.id);
    expect(sandboxCount()).toBe(0);
    expect(() => createSandbox({
      config: { mode: "ephemeral" },
      manager: { maxConcurrentSandboxes: 1, rootDir, skipSignalHooks: true },
    })).not.toThrow();
  });
});

describe("sandbox manager — list / get diagnostic", () => {
  it("listSandboxes returns refs in registration order", () => {
    const a = createSandbox({ config: { mode: "ephemeral" }, manager: { maxConcurrentSandboxes: 4, rootDir, skipSignalHooks: true } });
    const b = createSandbox({ config: { mode: "ephemeral" }, manager: { maxConcurrentSandboxes: 4, rootDir, skipSignalHooks: true } });
    const list = listSandboxes();
    expect(list.length).toBe(2);
    const ids = list.map((r) => r.id);
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
  });
});
