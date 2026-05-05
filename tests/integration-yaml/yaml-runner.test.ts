/**
 * M9 acceptance — YAML runner end-to-end.
 *
 * Runs `examples/bash-smoke.yaml` and `examples/sandbox-zshrc-test.yaml`
 * through the actual runner pipeline (parse → validate → spawn → drive
 * steps → close).
 */

import { describe, it, expect, afterAll } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { loadCase, runCase } from "../../src/adapters/yaml/runner.js";
import { __resetForTests as resetCleanup } from "../../src/core/process-cleanup.js";
import { __resetForTests as resetMgr } from "../../src/core/sandbox/manager.js";

afterAll(() => { resetCleanup(); resetMgr(); });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXAMPLES = path.resolve(__dirname, "..", "..", "examples");

const TIMEOUT = 20_000;

describe("yaml runner — examples", () => {
  it("bash-smoke.yaml runs to completion", async () => {
    const c = loadCase(path.join(EXAMPLES, "bash-smoke.yaml"));
    const r = await runCase(c, { caseFile: "bash-smoke.yaml" });
    expect(r.ok).toBe(true);
    expect(r.stepsRun).toBe(c.steps.length);
  }, TIMEOUT);

  it("sandbox-zshrc-test.yaml runs in an ephemeral sandbox", async () => {
    const c = loadCase(path.join(EXAMPLES, "sandbox-zshrc-test.yaml"));
    const r = await runCase(c, { caseFile: "sandbox-zshrc-test.yaml" });
    expect(r.ok).toBe(true);
    expect(r.stepsRun).toBe(c.steps.length);
  }, TIMEOUT);
});

describe("yaml runner — failure path", () => {
  it("expect timeout fails the case + dumps artifacts", async () => {
    // Build an in-memory case that will timeout.
    const c = await loadCase(makeTempCase(`
name: fail-on-timeout
session:
  command: bash
  rows: 24
  cols: 80
steps:
  - expect_regex:
      pattern: 'NEVER_APPEARS_LITERAL_TOKEN'
      timeout_ms: 200
`));
    const r = await runCase(c, { caseFile: "fail-on-timeout.yaml" });
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe("E_TT_EXPECT_TIMEOUT");
    expect(r.failedAt).toBe(0);
    // Artifact dump dir was created.
    expect(r.artifactsDir).toBeTruthy();
    expect(fs.existsSync(r.artifactsDir!)).toBe(true);
    // Cleanup.
    fs.rmSync(r.artifactsDir!, { recursive: true, force: true });
  }, TIMEOUT);

  it("malformed YAML surfaces a structured error from loadCase", () => {
    const f = makeTempCase("not: yaml: ok\n  bad-indent");
    expect(() => loadCase(f)).toThrow();
    fs.unlinkSync(f);
  });

  it("schema mismatch (missing required field) throws", () => {
    const f = makeTempCase(`
name: missing-session
steps:
  - write: "ignored"
`);
    expect(() => loadCase(f)).toThrow(/session/);
    fs.unlinkSync(f);
  });
});

function makeTempCase(content: string): string {
  const dir = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "ttm-yaml-test-"));
  const f = path.join(dir, "case.yaml");
  fs.writeFileSync(f, content);
  return f;
}
