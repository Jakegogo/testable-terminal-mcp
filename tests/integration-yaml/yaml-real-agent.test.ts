/**
 * YAML runner — real-agent end-to-end.
 *
 * Drives `examples/claude-real-agent.yaml` through ttm-run to prove the
 * full chain: YAML parse → schema → runner → Session → PTY → aikey
 * wrapper → Anthropic API → screen → assertion.
 *
 * Skipped unless RUN_REAL_AGENT_TESTS=1 + claude reachable via login shell.
 */

import { it, expect, afterAll } from "vitest";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { loadCase, runCase } from "../../src/adapters/yaml/runner.js";
import { __resetForTests as resetCleanup } from "../../src/core/process-cleanup.js";
import { __resetForTests as resetMgr } from "../../src/core/sandbox/manager.js";
import { describeIfReal } from "../integration-agent/_helpers.js";

afterAll(() => { resetCleanup(); resetMgr(); });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXAMPLES = path.resolve(__dirname, "..", "..", "examples");

describeIfReal("YAML runner — real claude agent", ["claude"], () => {
  it("examples/claude-real-agent.yaml runs end-to-end via aikey", async () => {
    const c = loadCase(path.join(EXAMPLES, "claude-real-agent.yaml"));
    const r = await runCase(c, { caseFile: "claude-real-agent.yaml" });
    if (!r.ok) {
      throw new Error(
        `YAML real-agent run failed at step ${r.failedAt} (${r.errorCode}): ${r.message}` +
        (r.artifactsDir ? `\nartifacts: ${r.artifactsDir}` : ""),
      );
    }
    expect(r.ok).toBe(true);
    expect(r.stepsRun).toBe(c.steps.length);
  }, 75_000);
});
