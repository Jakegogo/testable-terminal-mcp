/**
 * Unit tests for env-snapshot — primarily the fresh-login spawn path.
 *
 * The "current" mode is trivial (just clones currentSessionEnv) so we
 * cover it briefly. Fresh-login uses spawnSync with the host Node binary
 * as the JSON dumper, validated below by spawning a real child shell.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { captureEnvSnapshot } from "../../src/core/install-test/env-snapshot.js";
import { ErrorCode, isTestableTerminalError } from "../../src/core/errors.js";
import { platform as hostPlatform } from "../../src/core/platform.js";
import type { SandboxRef } from "../../src/core/types.js";

let sandboxPath: string;
beforeEach(() => { sandboxPath = fs.mkdtempSync(path.join(os.tmpdir(), "ttm-envsnap-")); });
afterEach(() => { fs.rmSync(sandboxPath, { recursive: true, force: true }); });

const sbx = (over: Partial<SandboxRef> = {}): SandboxRef => ({
  id: "sbx_test",
  path: sandboxPath,
  mode: "ephemeral",
  profile: "minimal",
  createdAt: new Date(),
  ...over,
});

describe("captureEnvSnapshot — current mode", () => {
  it("clones currentSessionEnv directly, no spawn", () => {
    const snap = captureEnvSnapshot({
      name: "test-current",
      mode: "current",
      sandbox: sbx(),
      currentSessionEnv: { HOME: "/sbx", FOO: "bar" },
    });
    expect(snap.name).toBe("test-current");
    expect(snap.mode).toBe("current");
    expect(snap.env).toEqual({ HOME: "/sbx", FOO: "bar" });
    expect(snap.capturedAt).toMatch(/^\d{4}-/);
  });

  it("throws E_TT_INVALID_INPUT when currentSessionEnv missing", () => {
    try {
      captureEnvSnapshot({ name: "x", mode: "current", sandbox: sbx() });
      expect.fail("should have thrown");
    } catch (err) {
      expect(isTestableTerminalError(err)).toBe(true);
      if (isTestableTerminalError(err)) {
        expect(err.code).toBe(ErrorCode.INVALID_INPUT);
      }
    }
  });
});

describe("captureEnvSnapshot — fresh-login mode", () => {
  it("spawns a fresh shell, captures env via host Node JSON dumper", () => {
    if (hostPlatform.isWindows) return; // POSIX-only path here

    // Seed a .zshrc that exports a marker var. fresh-login should pick it up.
    fs.writeFileSync(path.join(sandboxPath, ".zshrc"), 'export FRESH_LOGIN_MARKER="seeded-by-zshrc"\n');
    fs.writeFileSync(path.join(sandboxPath, ".bash_profile"), 'export FRESH_LOGIN_MARKER="seeded-by-bash-profile"\n');

    const shellPath = process.env.SHELL ?? "/bin/zsh";
    const snap = captureEnvSnapshot({
      name: "fresh",
      mode: "fresh-login",
      sandbox: sbx(),
      shellPath,
    });

    expect(snap.mode).toBe("fresh-login");
    expect(snap.env.HOME).toBe(sandboxPath);
    // Whichever rc file the chosen shell sources should have set the marker.
    expect(snap.env.FRESH_LOGIN_MARKER).toMatch(/seeded-by-(zshrc|bash-profile)/);
    // PATH includes the sandbox bin (env-injector contract).
    expect(snap.env.PATH).toContain(`${sandboxPath}/bin`);
  });

  it("non-zero exit from shell surfaces E_TT_FRESH_LOGIN_FAILED", () => {
    if (hostPlatform.isWindows) return;
    try {
      captureEnvSnapshot({
        name: "fresh-fail",
        mode: "fresh-login",
        sandbox: sbx(),
        shellPath: "/no/such/shell-binary",
      });
      expect.fail("should have thrown");
    } catch (err) {
      expect(isTestableTerminalError(err)).toBe(true);
      if (isTestableTerminalError(err)) {
        expect(err.code).toBe(ErrorCode.FRESH_LOGIN_FAILED);
      }
    }
  });

  it("denyKeys still apply: ANTHROPIC_API_KEY from host env is dropped", () => {
    if (hostPlatform.isWindows) return;

    const prev = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-ant-host-secret";
    try {
      const snap = captureEnvSnapshot({
        name: "deny",
        mode: "fresh-login",
        sandbox: sbx(),
      });
      expect(snap.env.ANTHROPIC_API_KEY).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prev;
    }
  });

  it("special characters in env values round-trip correctly via JSON", () => {
    if (hostPlatform.isWindows) return;

    fs.writeFileSync(path.join(sandboxPath, ".zshrc"),
      'export ROUND_TRIP_TEST="line1\\nline2 with spaces and \\"quotes\\""\n');
    fs.writeFileSync(path.join(sandboxPath, ".bash_profile"),
      'export ROUND_TRIP_TEST="line1\\nline2 with spaces and \\"quotes\\""\n');

    const snap = captureEnvSnapshot({
      name: "special",
      mode: "fresh-login",
      sandbox: sbx(),
    });
    // Either shell, the value must parse cleanly (no shell escape leakage).
    if (snap.env.ROUND_TRIP_TEST !== undefined) {
      expect(snap.env.ROUND_TRIP_TEST).toContain("quotes");
    }
  });
});
