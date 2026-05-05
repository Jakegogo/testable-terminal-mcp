/**
 * M5a acceptance #3 — aikey-init in skip mode does NOT touch .aikey/ inside
 * the sandbox; in-shell `[ -d $HOME/.aikey ]` reports absent (the bin/ subdir
 * is created by the manager profile, not the aikey seed step, so we check a
 * different marker).
 *
 * Probe-only sanity check is also covered:
 *   - mode=skip returns outcome="skip"
 *   - mode=aikey_init with valid Makefile returns outcome="skip" w/ step=4
 *     (M5a doesn't run the runner; M5b does)
 *   - mode=aikey_init with bad makefileDir returns outcome="fallback"
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runAikeyInit, probeAikeyInit } from "../../src/core/sandbox/aikey-init.js";
import { startSession } from "../../src/core/terminal-session.js";
import { createSandbox, __resetForTests as resetMgr } from "../../src/core/sandbox/manager.js";
import { __resetForTests as resetCleanup } from "../../src/core/process-cleanup.js";

afterAll(() => { resetCleanup(); resetMgr(); });

const TIMEOUT = 15_000;

describe("aikey-init — skip mode (M5a)", () => {
  it("skip mode returns outcome=skip and writes nothing to sandbox", async () => {
    const sbx = createSandbox({ config: { mode: "ephemeral" }, manager: { maxConcurrentSandboxes: 4, skipSignalHooks: true } });

    // Pre-state: .aikey/bin exists from profile minimal, but no .aikey/_inited.
    expect(fs.existsSync(path.join(sbx.path, ".aikey", "bin"))).toBe(true);
    expect(fs.existsSync(path.join(sbx.path, ".aikey", "_inited"))).toBe(false);

    const r = runAikeyInit({ sandboxPath: sbx.path, cfg: { mode: "skip" } });
    expect(r.outcome).toBe("skip");
    expect(r.step).toBe(1);

    // Post-state: still no _inited marker (skip mode never writes).
    expect(fs.existsSync(path.join(sbx.path, ".aikey", "_inited"))).toBe(false);

    // From inside the shell: [ -f $HOME/.aikey/_inited ] returns 1 (not present).
    const session = await startSession({ command: "bash", sandbox: sbx });
    try {
      await session.waitForRegex(/\$\s/, { timeoutMs: 3_000 });
      session.write('[ -f "$HOME/.aikey/_inited" ] && echo INITED_PRESENT || echo INITED_ABSENT\n');
      await session.waitForRegex(/INITED_ABSENT/, { timeoutMs: 3_000 });
    } finally {
      await session.close();
    }
  }, TIMEOUT);
});

describe("aikey-init — probe (4-step)", () => {
  let makefileDir: string;
  beforeEach(() => {
    makefileDir = fs.mkdtempSync(path.join(os.tmpdir(), "ttm-aikey-probe-"));
  });
  afterEach(() => {
    fs.rmSync(makefileDir, { recursive: true, force: true });
  });

  it("step 1: empty makefileDir → fallback", () => {
    const r = probeAikeyInit({ mode: "aikey_init" });
    expect(r.outcome).toBe("fallback");
    expect(r.step).toBe(1);
  });

  it("step 1: nonexistent dir → fallback", () => {
    const r = probeAikeyInit({ mode: "aikey_init", aikeyMakefileDir: "/no/such/dir" });
    expect(r.outcome).toBe("fallback");
    expect(r.step).toBe(1);
  });

  it("step 2: dir exists but no Makefile → fallback", () => {
    const r = probeAikeyInit({ mode: "aikey_init", aikeyMakefileDir: makefileDir });
    expect(r.outcome).toBe("fallback");
    expect(r.step).toBe(2);
  });

  it("step 3: Makefile present but no `sandbox` target → fallback", () => {
    fs.writeFileSync(path.join(makefileDir, "Makefile"), "other:\n\t@echo other\n");
    const r = probeAikeyInit({ mode: "aikey_init", aikeyMakefileDir: makefileDir });
    expect(r.outcome).toBe("fallback");
    expect(r.step).toBe(3);
  });

  it("step 4: full happy path → outcome=ok step=4", () => {
    fs.writeFileSync(path.join(makefileDir, "Makefile"), "sandbox:\n\t@echo seeded > $$HOME/.aikey/_inited\n");
    const r = probeAikeyInit({ mode: "aikey_init", aikeyMakefileDir: makefileDir });
    expect(r.outcome).toBe("ok");
    expect(r.step).toBe(4);
    expect(r.resolvedDir).toBe(makefileDir);
  });

  it("aikey_init mode (M5b) on a fixture Makefile writes _inited marker + returns ok", () => {
    // Fixture Makefile that writes _inited at the caller-supplied
    // --sandbox-dir. Using `$$2 ; $$3` would be brittle; we just take the
    // sandbox dir from $(filter --sandbox-dir=%, $(ARGS)) for portability.
    fs.writeFileSync(
      path.join(makefileDir, "Makefile"),
      [
        "SANDBOX_DIR := $(patsubst --sandbox-dir=%,%,$(filter --sandbox-dir=%,$(ARGS)))",
        "sandbox:",
        "\t@mkdir -p $(SANDBOX_DIR)",
        "\t@echo seeded > $(SANDBOX_DIR)/_inited",
        "\t@echo SANDBOX_PATH=$(SANDBOX_DIR)",
      ].join("\n") + "\n",
    );
    const sbxDir = fs.mkdtempSync(path.join(os.tmpdir(), "ttm-aikey-real-"));
    try {
      const r = runAikeyInit({
        sandboxPath: sbxDir,
        cfg: { mode: "aikey_init", aikeyMakefileDir: makefileDir },
      });
      expect(r.outcome).toBe("ok");
      expect(r.step).toBe(4);
      expect(r.sandboxPath).toBe(sbxDir);
      // Marker really written.
      expect(fs.existsSync(path.join(sbxDir, "_inited"))).toBe(true);
    } finally {
      fs.rmSync(sbxDir, { recursive: true, force: true });
    }
  });

  it("aikey_init mode: failed make run throws SANDBOX_AIKEY_INIT_FAILED with hint", () => {
    fs.writeFileSync(
      path.join(makefileDir, "Makefile"),
      "sandbox:\n\t@false # always fails\n",
    );
    const sbxDir = fs.mkdtempSync(path.join(os.tmpdir(), "ttm-aikey-fail-"));
    try {
      expect(() => runAikeyInit({
        sandboxPath: sbxDir,
        cfg: { mode: "aikey_init", aikeyMakefileDir: makefileDir },
      })).toThrow(/SANDBOX_AIKEY_INIT_FAILED|sandbox.*failed/i);
    } finally {
      fs.rmSync(sbxDir, { recursive: true, force: true });
    }
  });
});
