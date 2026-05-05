/**
 * aikey-init real-makefile probe — verifies the probe + the M5b runner
 * surface against the live aikey-cli checkout.
 *
 * What this test verifies:
 *   - probeAikeyInit correctly classifies the real aikey Makefile (steps
 *     1-3 pass; step 4 = "ok to run").
 *   - sandbox_shell.py ships the `--no-shell` + `--sandbox-dir` flags
 *     that the M5b runner depends on.
 *
 * What this test DOES NOT do:
 *   - Does NOT execute `make sandbox` end-to-end. That requires the aikey
 *     CI Python deps (pytest, pyyaml) to be installed, which isn't a
 *     given on every dev machine. Live-run integration is in
 *     `aikey-init-real-run.test.ts` — it self-skips when pytest is
 *     unavailable.
 *
 * Skipped if the aikey checkout is not present at the expected path.
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import { probeAikeyInit, runAikeyInit } from "../../src/core/sandbox/aikey-init.js";

const AIKEY_MAKEFILE_DIR = "/Users/jake/Projects/aikeylabs/workflow/CI";
const aikeyAvailable = fs.existsSync(`${AIKEY_MAKEFILE_DIR}/Makefile`);

const skipReason = aikeyAvailable ? null : "aikey checkout not at " + AIKEY_MAKEFILE_DIR;

describe.skipIf(!aikeyAvailable)(`aikey-init probe — real ${AIKEY_MAKEFILE_DIR}`, () => {
  it("probe step 1-3 all pass against real aikey Makefile", () => {
    const r = probeAikeyInit({
      mode: "aikey_init",
      aikeyMakefileDir: AIKEY_MAKEFILE_DIR,
    });
    expect(r.outcome).toBe("ok");
    expect(r.step).toBe(4);
    expect(r.resolvedDir).toBe(AIKEY_MAKEFILE_DIR);
  });

  it("aikey sandbox_shell.py ships --no-shell + --sandbox-dir flags (M5b prereq)", () => {
    // Surface check: the M5b runner depends on these two flags. If aikey
    // upgrades and removes them, this test fires loudly so we know to
    // adapt rather than silently hang on the interactive default.
    const py = fs.readFileSync(`${AIKEY_MAKEFILE_DIR}/sandbox_shell.py`, "utf8");
    expect(py).toMatch(/--no-shell/);
    expect(py).toMatch(/--sandbox-dir/);
  });

  it("Makefile sandbox target accepts $(ARGS) passthrough", () => {
    const makefile = fs.readFileSync(`${AIKEY_MAKEFILE_DIR}/Makefile`, "utf8");
    expect(makefile).toMatch(/\nsandbox:\n\tcd \$\(CI_DIR\) && \$\(PYTHON\) sandbox_shell\.py \$\(ARGS\)/);
  });
});

if (skipReason) {
  describe.skip(`aikey-init probe SKIPPED: ${skipReason}`, () => {
    it("placeholder", () => { /* never runs */ });
  });
}
