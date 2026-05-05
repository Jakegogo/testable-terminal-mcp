/**
 * YAML runner — load a case file, execute its steps in order, dump artifacts
 * on failure.
 *
 * Step semantics map 1:1 to Session methods + the install-test asserts +
 * snapshot-test assertSnapshot. The runner is a thin orchestrator: parse →
 * validate → spawn session → drive steps → handle failure with structured
 * artifact dump.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { logger } from "../../utils/logger.js";
import { parseYaml } from "../../utils/yaml-mini.js";
import { Session, startSession } from "../../core/terminal-session.js";
import { createSandbox, destroySandbox } from "../../core/sandbox/manager.js";
import { assertSnapshot } from "../../core/snapshot-test/index.js";
import { ErrorCode, isTestableTerminalError, TestableTerminalError } from "../../core/errors.js";
import { CaseSchema, type YamlCase, type YamlStep } from "./schema.js";

// ─── public API ──────────────────────────────────────────────────────────────

export interface RunResult {
  /** True iff every step ran without throwing. */
  ok: boolean;
  /** Step index that failed (when !ok). */
  failedAt?: number;
  /** Error code from the failure (when !ok). */
  errorCode?: string;
  /** Error message. */
  message?: string;
  /** Artifact dump dir (when a failure dumped artifacts). */
  artifactsDir?: string;
  /** Total steps that completed before failure / end. */
  stepsRun: number;
}

/** Load + validate a YAML case from disk. */
export function loadCase(filePath: string): YamlCase {
  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = parseYaml(raw);
  const result = CaseSchema.safeParse(parsed);
  if (!result.success) {
    throw new TestableTerminalError(
      ErrorCode.INVALID_INPUT,
      `YAML case validation failed: ${result.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`,
      { filePath, issues: result.error.issues },
    );
  }
  return result.data;
}

/** Run a parsed case end-to-end. */
export async function runCase(testCase: YamlCase, opts: { caseFile?: string } = {}): Promise<RunResult> {
  const caseLogger = logger.child({ case: testCase.name });
  caseLogger.info("yaml.run.start", { steps: testCase.steps.length });

  // ── set up session (+ sandbox if requested) ─────────────────────────────
  const sb = testCase.session.sandbox
    ? createSandbox({
      config: {
        mode: testCase.session.sandbox,
        path: testCase.session.sandbox_path,
        profile: testCase.session.sandbox_profile,
      },
      manager: { maxConcurrentSandboxes: 16, skipSignalHooks: true },
    })
    : null;

  let session: Session;
  try {
    session = await startSession({
      command: testCase.session.command,
      args: testCase.session.args,
      rows: testCase.session.rows,
      cols: testCase.session.cols,
      cwd: testCase.session.cwd,
      loginShell: testCase.session.login_shell,
      preSourceFiles: testCase.session.pre_source_files.length > 0 ? testCase.session.pre_source_files : undefined,
      simulatePrecmdHooks: testCase.session.simulate_precmd_hooks || undefined,
      env: testCase.session.env,
      sandbox: sb ?? undefined,
      envInheritance: testCase.session.env_inheritance ? { mode: testCase.session.env_inheritance } : undefined,
      isolateTemp: testCase.session.isolate_temp,
    });
  } catch (err) {
    if (sb) destroySandbox(sb.id);
    return failed(0, err, undefined);
  }

  // ── execute steps ────────────────────────────────────────────────────────
  let stepsRun = 0;
  try {
    for (let i = 0; i < testCase.steps.length; i++) {
      const step = testCase.steps[i]!;
      caseLogger.debug("yaml.step", { idx: i, op: stepName(step) });
      await executeStep(session, step, testCase, opts.caseFile);
      stepsRun = i + 1;
    }
    caseLogger.info("yaml.run.ok", { stepsRun });
    return { ok: true, stepsRun };
  } catch (err) {
    caseLogger.error("yaml.run.failed", {
      atStep: stepsRun,
      message: (err as Error).message,
    });
    const dump = dumpOnFailure(session, testCase);
    return failed(stepsRun, err, dump);
  } finally {
    try { await session.close(); } catch { /* ignore */ }
    if (sb) destroySandbox(sb.id);
  }
}

// ─── step dispatcher ────────────────────────────────────────────────────────

async function executeStep(session: Session, step: YamlStep, testCase: YamlCase, caseFile?: string): Promise<void> {
  if ("write" in step) {
    session.write(step.write);
    return;
  }
  if ("send_key" in step) {
    session.sendKey(step.send_key);
    return;
  }
  if ("resize" in step) {
    session.resize(step.resize.rows, step.resize.cols);
    return;
  }
  if ("sleep_ms" in step) {
    await new Promise((r) => setTimeout(r, step.sleep_ms));
    return;
  }
  if ("expect_text" in step) {
    await session.waitForText(step.expect_text.text, { timeoutMs: step.expect_text.timeout_ms });
    return;
  }
  if ("expect_regex" in step) {
    const re = new RegExp(step.expect_regex.pattern, step.expect_regex.flags);
    await session.waitForRegex(re, { timeoutMs: step.expect_regex.timeout_ms });
    return;
  }
  if ("expect_idle" in step) {
    await session.waitForIdle({
      stabilityMs: step.expect_idle.idle_ms,
      timeoutMs: step.expect_idle.max_wait_ms,
      requireFirstEvent: step.expect_idle.require_first_event,
    });
    return;
  }
  if ("expect_change" in step) {
    await session.waitForChange({ timeoutMs: step.expect_change.max_wait_ms });
    return;
  }
  if ("wait_exit" in step) {
    await session.waitForExit({ timeoutMs: step.wait_exit.max_wait_ms });
    return;
  }
  if ("snapshot" in step) {
    const screen = session.snapshot({ range: "viewport" });
    const testFileId = caseFile ? path.basename(caseFile) : testCase.name;
    assertSnapshot({
      rootDir: testCase.snapshot_root_dir,
      testFileId,
      caseName: step.snapshot.name,
      maskPresets: step.snapshot.masks,
      masks: step.snapshot.inline_masks,
      includeAnsi: step.snapshot.include_ansi,
      actual: { plain: screen.plainText, ansi: step.snapshot.include_ansi ? screen.ansiText : undefined },
      session: {
        command: testCase.session.command,
        rows: testCase.session.rows,
        cols: testCase.session.cols,
        ...(testCase.session.sandbox ? { sandbox: testCase.session.sandbox } : {}),
      },
    });
    return;
  }
  if ("env_snapshot" in step) {
    session.envSnapshot(step.env_snapshot.name, { mode: step.env_snapshot.mode });
    return;
  }
  if ("assert_env_no_path_duplicates" in step) {
    session.assertEnvNoPathDuplicates(step.assert_env_no_path_duplicates.snapshot);
    return;
  }
  if ("assert_env_diff" in step) {
    session.assertEnvDiff(
      step.assert_env_diff.before,
      step.assert_env_diff.after,
      {
        allowedChanges: step.assert_env_diff.allowed_changes.map((c) => ({
          key: c.key,
          op: c.op,
          ...(c.value_pattern ? { valuePattern: c.value_pattern } : {}),
        })),
      },
    );
    return;
  }
  if ("assert_file_unchanged" in step) {
    session.assertFileUnchanged(step.assert_file_unchanged.path, {
      baselineId: step.assert_file_unchanged.baseline_id,
    });
    return;
  }
  if ("dump_artifacts" in step) {
    session.dumpArtifacts({
      dir: step.dump_artifacts.dir,
      includeAnsiSnapshot: step.dump_artifacts.include_ansi_snapshot,
    });
    return;
  }
  if ("close" in step) {
    await session.close();
    return;
  }
  // Exhaustive: zod's discriminated union prevents this at compile time, but
  // runtime check guards against future schema additions without dispatcher.
  throw new TestableTerminalError(
    ErrorCode.INVALID_INPUT,
    `unknown step shape: ${JSON.stringify(Object.keys(step))}`,
    { step },
  );
}

// ─── failure handling ──────────────────────────────────────────────────────

function dumpOnFailure(session: Session, testCase: YamlCase): { artifactsDir: string } | undefined {
  try {
    const dir = testCase.artifacts_dir ?? path.join("./artifacts", slugify(testCase.name));
    const r = session.dumpArtifacts({ dir });
    return { artifactsDir: r.dir };
  } catch (err) {
    logger.warn("yaml.artifact_dump_failed", { message: (err as Error).message });
    return undefined;
  }
}

function failed(stepsRun: number, err: unknown, dump?: { artifactsDir: string }): RunResult {
  const code = isTestableTerminalError(err) ? err.code : "UNKNOWN";
  return {
    ok: false,
    failedAt: stepsRun,
    errorCode: code,
    message: (err as Error).message,
    stepsRun,
    artifactsDir: dump?.artifactsDir,
  };
}

function stepName(step: YamlStep): string {
  return Object.keys(step)[0] ?? "<unknown>";
}

function slugify(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, "_");
}
