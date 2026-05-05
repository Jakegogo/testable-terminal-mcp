/**
 * M6 acceptance — fixture × assert matrix per round-12 self-review.
 *
 * Each fixture has one main assert it's designed to flag (✓), with
 * "good-install" as the all-pass baseline. Tests run the installer via
 * spawnSync with sandbox HOME injected, NOT through the PTY — env-snapshot
 * and file-baseline operate on the host fs directly, which is the spec
 * design (sandbox is a real host dir, no PTY needed for installer probes).
 *
 * Round-7 zshrc-only / round-8 bashrc-only & bash-profile fixtures verify
 * the fresh-login default actually catches changes that mode=current
 * misses (and that we correctly model bash's `.bashrc`-not-read-on-login
 * behavior).
 */

import { describe, it, expect, afterAll, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ErrorCode, isTestableTerminalError, TestableTerminalError } from "../../src/core/errors.js";
import { startSession } from "../../src/core/terminal-session.js";
import {
  createSandbox, __resetForTests as resetMgr,
} from "../../src/core/sandbox/manager.js";
import { __resetForTests as resetCleanup } from "../../src/core/process-cleanup.js";
import { captureEnvSnapshot } from "../../src/core/install-test/env-snapshot.js";
import { assertEnvNoPathDuplicates } from "../../src/core/install-test/asserts/env-no-path-duplicates.js";
import { assertEnvDiff } from "../../src/core/install-test/asserts/env-diff.js";
import { assertIdempotentInstall } from "../../src/core/install-test/asserts/idempotent-install.js";
import {
  assertMonitoredPathsUnchanged, snapshotMonitoredPaths,
} from "../../src/core/install-test/asserts/monitored-paths-unchanged.js";
import { platform as hostPlatform } from "../../src/core/platform.js";

afterAll(() => { resetCleanup(); resetMgr(); });

const TIMEOUT = 20_000;
const FIXTURE_DIR = path.join(__dirname, "..", "fixtures", "stub-installer");
// Pin zsh for these tests — the fixtures write to ~/.zshrc so a fresh-login
// snapshot must use zsh to see the changes. CI runners (Ubuntu / macOS GH)
// default $SHELL=/bin/bash; without this pin, fresh-login spawns bash which
// doesn't read .zshrc, the env doesn't change, and the assertion that
// expects PATH duplicates / new vars wrongly says "no diff".
const ZSH_PATH: string | undefined = (() => {
  for (const candidate of ["/bin/zsh", "/usr/bin/zsh", "/usr/local/bin/zsh"]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined; // no zsh on this host → these tests early-return below
})();

// Run an installer script with HOME pointed at the sandbox. spawnSync,
// not PTY — installer scripts don't need a terminal.
function runInstaller(opts: { sandboxPath: string; script: string; extraEnv?: Record<string, string> }): void {
  const r = spawnSync("/bin/sh", [path.join(FIXTURE_DIR, opts.script)], {
    env: {
      ...filterStringEnv(process.env),
      HOME: opts.sandboxPath,
      ...(opts.extraEnv ?? {}),
    },
    encoding: "utf8",
    timeout: 5_000,
  });
  if (r.status !== 0) {
    throw new Error(`installer ${opts.script} exited ${r.status}: ${r.stderr}`);
  }
}

function filterStringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (typeof v === "string") out[k] = v;
  return out;
}

beforeEach(() => { /* nothing — each test creates its own sandbox(es) */ });
afterEach(() => { resetMgr(); });

// ─── good-install: baseline ─────────────────────────────────────────────────

describe("install-test matrix — good-install.sh (baseline)", () => {
  it("env_snapshot before/after; env_diff with PATH-prepend allowed; no PATH dups", async () => {
    if (hostPlatform.isWindows || !ZSH_PATH) return;
    const sbx = createSandbox({ config: { mode: "ephemeral" }, manager: { maxConcurrentSandboxes: 4, skipSignalHooks: true } });

    const before = captureEnvSnapshot({ name: "before", mode: "fresh-login", sandbox: sbx, shellPath: ZSH_PATH });
    runInstaller({ sandboxPath: sbx.path, script: "good-install.sh" });
    const after = captureEnvSnapshot({ name: "after", mode: "fresh-login", sandbox: sbx, shellPath: ZSH_PATH });

    // PATH may pick up the prepended dir; new GOOD_INSTALLED_PATH var added.
    expect(() => assertEnvDiff({
      before, after,
      allowedChanges: [
        { key: "PATH", op: "modify" },
        { key: "GOOD_INSTALLED_PATH", op: "add" },
      ],
    })).not.toThrow();
    expect(() => assertEnvNoPathDuplicates({ snapshot: after })).not.toThrow();
  }, TIMEOUT);

  it("idempotent_install on good-install.sh succeeds (guarded re-run)", async () => {
    if (hostPlatform.isWindows || !ZSH_PATH) return;
    const sbx = createSandbox({ config: { mode: "ephemeral" }, manager: { maxConcurrentSandboxes: 4, skipSignalHooks: true } });

    await assertIdempotentInstall({
      sandbox: sbx,
      runCommand: async () => runInstaller({ sandboxPath: sbx.path, script: "good-install.sh" }),
      filesToCompare: [".zshrc"],
      captureEnv: async (name) => captureEnvSnapshot({ name, mode: "fresh-login", sandbox: sbx, shellPath: ZSH_PATH }),
    });
    // No throw → passed.
  }, TIMEOUT);
});

// ─── duplicate-path: PATH dup detection ─────────────────────────────────────

describe("install-test matrix — duplicate-path.sh", () => {
  it("running twice produces PATH duplicates → assert flags it", async () => {
    if (hostPlatform.isWindows || !ZSH_PATH) return;
    const sbx = createSandbox({ config: { mode: "ephemeral" }, manager: { maxConcurrentSandboxes: 4, skipSignalHooks: true } });

    runInstaller({ sandboxPath: sbx.path, script: "duplicate-path.sh" });
    runInstaller({ sandboxPath: sbx.path, script: "duplicate-path.sh" });

    const after = captureEnvSnapshot({ name: "after", mode: "fresh-login", sandbox: sbx, shellPath: ZSH_PATH });
    try {
      assertEnvNoPathDuplicates({ snapshot: after });
      expect.fail("should have flagged PATH duplicates");
    } catch (err) {
      expect(isTestableTerminalError(err)).toBe(true);
      if (isTestableTerminalError(err)) {
        expect(err.code).toBe(ErrorCode.ASSERT_PATH_DUPLICATES);
        const dup = (err.details as { duplicates: { dir: string }[] }).duplicates;
        expect(dup.find((d) => d.dir.endsWith("/.dup/bin"))).not.toBeUndefined();
      }
    }
  }, TIMEOUT);
});

// ─── leaks-to-host: outside-sandbox write detection ─────────────────────────

describe("install-test matrix — leaks-to-host.sh", () => {
  it("writes outside sandbox → monitored_paths_unchanged catches it (CI-safe via TT_LEAK_TARGET)", async () => {
    if (hostPlatform.isWindows) return;
    const sbx = createSandbox({ config: { mode: "ephemeral" }, manager: { maxConcurrentSandboxes: 4, skipSignalHooks: true } });

    // Spec calls for the leak target to be a tmp file (not /etc/zshrc) on CI.
    const leakTarget = path.join(os.tmpdir(), `ttm-leak-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
    fs.writeFileSync(leakTarget, ""); // baseline empty

    try {
      const before = snapshotMonitoredPaths([leakTarget]);
      runInstaller({
        sandboxPath: sbx.path,
        script: "leaks-to-host.sh",
        extraEnv: { TT_LEAK_TARGET: leakTarget },
      });
      const after = snapshotMonitoredPaths([leakTarget]);

      try {
        assertMonitoredPathsUnchanged({ before, after });
        expect.fail("should have flagged the leak");
      } catch (err) {
        expect(isTestableTerminalError(err)).toBe(true);
        if (isTestableTerminalError(err)) {
          expect(err.code).toBe(ErrorCode.ASSERT_OUTSIDE_LEAK);
          const leaks = (err.details as { leaks: { path: string; op: string }[] }).leaks;
          expect(leaks[0]!.path).toBe(leakTarget);
          expect(leaks[0]!.op).toBe("modified");
        }
      }
    } finally {
      try { fs.unlinkSync(leakTarget); } catch { /* ignore */ }
    }
  }, TIMEOUT);
});

// ─── non-idempotent: round-1 vs round-2 file diff ──────────────────────────

describe("install-test matrix — non-idempotent.sh", () => {
  it("two rounds yield different .zshrc content → assertIdempotentInstall throws", async () => {
    if (hostPlatform.isWindows || !ZSH_PATH) return;
    const sbx = createSandbox({ config: { mode: "ephemeral" }, manager: { maxConcurrentSandboxes: 4, skipSignalHooks: true } });

    try {
      await assertIdempotentInstall({
        sandbox: sbx,
        runCommand: async () => {
          runInstaller({ sandboxPath: sbx.path, script: "non-idempotent.sh" });
          // Tiny sleep so the timestamp / random suffix actually differs.
          await new Promise((r) => setTimeout(r, 5));
        },
        filesToCompare: [".zshrc"],
        captureEnv: async (name) => captureEnvSnapshot({ name, mode: "fresh-login", sandbox: sbx, shellPath: ZSH_PATH }),
      });
      expect.fail("should have flagged non-idempotence");
    } catch (err) {
      expect(isTestableTerminalError(err)).toBe(true);
      if (isTestableTerminalError(err)) {
        expect(err.code).toBe(ErrorCode.ASSERT_NOT_IDEMPOTENT);
        const fileDiffs = (err.details as { fileDiffs: { path: string }[] }).fileDiffs;
        expect(fileDiffs.find((f) => f.path === ".zshrc")).not.toBeUndefined();
      }
    }
  }, TIMEOUT);
});

// ─── writes-zshrc-only: proves fresh-login default ─────────────────────────

describe("install-test matrix — writes-zshrc-only.sh (round 7)", () => {
  it("mode=current misses .zshrc-only change; mode=fresh-login (zsh) catches it", async () => {
    if (hostPlatform.isWindows) return;
    if (!fs.existsSync("/bin/zsh") && !fs.existsSync("/usr/bin/zsh")) return; // need zsh

    const sbx = createSandbox({ config: { mode: "ephemeral" }, manager: { maxConcurrentSandboxes: 4, skipSignalHooks: true } });

    const session = await startSession({ command: "bash", sandbox: sbx });
    try {
      await session.waitForRegex(/\$\s/, { timeoutMs: 3_000 });

      // mode=current snapshot — uses session.originalEnv (caller-provided env at spawn).
      const beforeCurrent = session.envSnapshot("before-current", { mode: "current" });
      runInstaller({ sandboxPath: sbx.path, script: "writes-zshrc-only.sh" });
      const afterCurrent = session.envSnapshot("after-current", { mode: "current" });

      // mode=current can't possibly see .zshrc edits (caller env didn't change).
      expect(beforeCurrent.env.ZSHRC_ONLY_VAR).toBeUndefined();
      expect(afterCurrent.env.ZSHRC_ONLY_VAR).toBeUndefined();
      // FALSE PASS: env_diff in `current` would say "no unexpected changes".

      // mode=fresh-login WITH zsh shell catches the new var.
      const zshPath = fs.existsSync("/bin/zsh") ? "/bin/zsh" : "/usr/bin/zsh";
      const afterFresh = captureEnvSnapshot({
        name: "after-fresh", mode: "fresh-login", sandbox: sbx, shellPath: zshPath,
      });
      expect(afterFresh.env.ZSHRC_ONLY_VAR).toBe("zshrc-only-installed");
    } finally {
      await session.close();
    }
  }, TIMEOUT);
});

// ─── writes-bashrc-only: bash -il doesn't read .bashrc (real signal) ───────

describe("install-test matrix — writes-bashrc-only.sh (round 8)", () => {
  it("fresh-login + bash -il does NOT see .bashrc-only edits", async () => {
    if (hostPlatform.isWindows) return;
    if (!fs.existsSync("/bin/bash")) return;

    const sbx = createSandbox({ config: { mode: "ephemeral" }, manager: { maxConcurrentSandboxes: 4, skipSignalHooks: true } });
    runInstaller({ sandboxPath: sbx.path, script: "writes-bashrc-only.sh" });

    const snap = captureEnvSnapshot({
      name: "bashrc-only", mode: "fresh-login", sandbox: sbx, shellPath: "/bin/bash",
    });
    // `.bashrc` writes are invisible to a bash login shell — the spec
    // calls this out as a "real signal" of installer bug.
    expect(snap.env.BASHRC_ONLY_VAR).toBeUndefined();
  }, TIMEOUT);

  it("with .bash_profile that sources .bashrc, the var becomes visible", async () => {
    if (hostPlatform.isWindows) return;
    if (!fs.existsSync("/bin/bash")) return;

    const sbx = createSandbox({
      config: {
        mode: "ephemeral",
        seed: { files: { ".bash_profile": "[ -f \"$HOME/.bashrc\" ] && . \"$HOME/.bashrc\"\n" } },
      },
      manager: { maxConcurrentSandboxes: 4, skipSignalHooks: true },
    });
    runInstaller({ sandboxPath: sbx.path, script: "writes-bashrc-only.sh" });

    const snap = captureEnvSnapshot({
      name: "bashrc-via-profile", mode: "fresh-login", sandbox: sbx, shellPath: "/bin/bash",
    });
    expect(snap.env.BASHRC_ONLY_VAR).toBe("bashrc-only-installed");
  }, TIMEOUT);
});

// ─── writes-bash-profile: bash -il DOES read .bash_profile (control) ───────

describe("install-test matrix — writes-bash-profile.sh (round 8)", () => {
  it("fresh-login + bash -il sees .bash_profile edits", async () => {
    if (hostPlatform.isWindows) return;
    if (!fs.existsSync("/bin/bash")) return;

    const sbx = createSandbox({ config: { mode: "ephemeral" }, manager: { maxConcurrentSandboxes: 4, skipSignalHooks: true } });
    runInstaller({ sandboxPath: sbx.path, script: "writes-bash-profile.sh" });

    const snap = captureEnvSnapshot({
      name: "bash-profile", mode: "fresh-login", sandbox: sbx, shellPath: "/bin/bash",
    });
    expect(snap.env.BASH_PROFILE_VAR).toBe("bash-profile-installed");
  }, TIMEOUT);
});

// ─── Session API smoke ─────────────────────────────────────────────────────

describe("Session install-test API", () => {
  it("session.envSnapshot + assertEnvDiff + assertEnvNoPathDuplicates wired up", async () => {
    if (hostPlatform.isWindows || !ZSH_PATH) return;
    // Pin SHELL so session.envSnapshot's fresh-login default uses zsh —
    // good-install.sh writes to .zshrc and a bash login shell wouldn't see it.
    const prevShell = process.env.SHELL;
    process.env.SHELL = ZSH_PATH;
    try {
      const sbx = createSandbox({ config: { mode: "ephemeral" }, manager: { maxConcurrentSandboxes: 4, skipSignalHooks: true } });
      const session = await startSession({ command: "bash", sandbox: sbx });
      try {
        await session.waitForRegex(/\$\s/, { timeoutMs: 3_000 });
        session.envSnapshot("before");
        runInstaller({ sandboxPath: sbx.path, script: "good-install.sh" });
        session.envSnapshot("after");

        // baseline env_diff — explicitly allow GOOD_INSTALLED_PATH add + PATH modify.
        session.assertEnvDiff("before", "after", {
          allowedChanges: [
            { key: "GOOD_INSTALLED_PATH", op: "add" },
            { key: "PATH", op: "modify" },
          ],
        });
        session.assertEnvNoPathDuplicates("after");
      } finally {
        await session.close();
      }
    } finally {
      if (prevShell !== undefined) process.env.SHELL = prevShell;
      else delete process.env.SHELL;
    }
  }, TIMEOUT);

  it("session.assertFileUnchanged uses auto-baselines from session create", async () => {
    if (hostPlatform.isWindows) return;
    const sbx = createSandbox({ config: { mode: "ephemeral" }, manager: { maxConcurrentSandboxes: 4, skipSignalHooks: true } });
    const session = await startSession({ command: "bash", sandbox: sbx });
    try {
      await session.waitForRegex(/\$\s/, { timeoutMs: 3_000 });

      // Initially .bashrc absent → baseline says sha256=null.
      // After installer that doesn't touch .bashrc, assert should pass.
      runInstaller({ sandboxPath: sbx.path, script: "writes-bash-profile.sh" });
      expect(() => session.assertFileUnchanged(".bashrc")).not.toThrow();

      // Now create .bashrc — assertion should fire.
      runInstaller({ sandboxPath: sbx.path, script: "writes-bashrc-only.sh" });
      try {
        session.assertFileUnchanged(".bashrc");
        expect.fail("should have flagged .bashrc change");
      } catch (err) {
        expect(isTestableTerminalError(err)).toBe(true);
        if (isTestableTerminalError(err)) {
          expect(err.code).toBe(ErrorCode.ASSERT_FILE_CHANGED);
        }
      }
    } finally {
      await session.close();
    }
  }, TIMEOUT);
});
