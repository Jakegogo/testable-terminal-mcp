/**
 * aikey-init — sandbox seed step that runs aikey's `make sandbox` to
 * populate `<sandbox>/.aikey/` with bin + config + provider keys.
 *
 * Two modes:
 *   "skip"        — no-op (M5a default). Sandbox is still useful without
 *                   aikey seeded; consumers that need `.aikey/` should use
 *                   `aikey_init` mode.
 *   "aikey_init"  — full seed via the upstream `make sandbox -- --no-shell
 *                   --sandbox-dir=<path>` invocation. Requires aikey ≥ the
 *                   version that ships --no-shell + --sandbox-dir flags.
 *                   We probe with `make -n sandbox` first (cheap) and fail
 *                   loudly if anything goes wrong on the real run.
 *   "copy_from_host" — M5b deferred (M5a placeholder).
 *
 * 4-step probe (used by both modes for diagnostics):
 *   1. aikeyMakefileDir resolved
 *   2. <dir>/Makefile exists
 *   3. `make -n sandbox` returns 0 (target declared)
 *   4. real run via `make sandbox -- --no-shell --sandbox-dir=<path>`
 *
 * Errors:
 *   probe failures (steps 1-3)        → outcome="fallback", warn-skip
 *   real run fails (step 4)           → throw E_TT_SANDBOX_AIKEY_INIT_FAILED
 *   aikey-side dependency missing     → throw E_TT_SANDBOX_AIKEY_INIT_FAILED
 *                                       with hint to `make install-deps`
 */

import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { ErrorCode, TestableTerminalError } from "../errors.js";
import { logger } from "../../utils/logger.js";

// ─── public types ────────────────────────────────────────────────────────────

export type AikeySeedMode = "skip" | "aikey_init" | "copy_from_host";

export interface AikeySeedConfig {
  mode: AikeySeedMode;
  /** Required for mode=aikey_init. Typically <aikeylabs>/workflow/CI. */
  aikeyMakefileDir?: string;
  /** Default "make sandbox" — overridable for tests / custom targets. */
  command?: string;
  /** Extra env passed to the make invocation. */
  extraEnv?: Record<string, string>;
  /** mode=copy_from_host source (default ~/.aikey). M5b deferred. */
  from?: string;
  /** Real-run timeout in ms. Default 60_000 (aikey bootstrap can be slow). */
  timeoutMs?: number;
}

export interface AikeyProbeResult {
  /**
   * "ok"        — probe passed, real run succeeded (M5b mode only)
   * "skip"      — caller said skip, OR M5a placeholder for aikey_init
   * "fallback"  — probe failed; caller continues without aikey seeded
   */
  outcome: "ok" | "skip" | "fallback";
  step: 1 | 2 | 3 | 4;
  reason: string;
  resolvedDir?: string;
  /** When step=4 succeeded, path to the seeded sandbox (always == sandboxPath). */
  sandboxPath?: string;
}

// ─── public API ──────────────────────────────────────────────────────────────

/**
 * Drive the aikey seed step against the supplied sandbox path.
 *
 * Behavior matrix:
 *   skip          → returns immediately
 *   aikey_init    → probes; if probe fails returns fallback; if probe ok,
 *                   spawns `make sandbox -- --no-shell --sandbox-dir=<path>`
 *                   and verifies the `_inited` marker
 *   copy_from_host → M5a stub (warn + skip)
 */
export function runAikeyInit(opts: { sandboxPath: string; cfg: AikeySeedConfig }): AikeyProbeResult {
  const { cfg, sandboxPath } = opts;
  switch (cfg.mode) {
    case "skip":
      return { outcome: "skip", step: 1, reason: "AikeySeedConfig.mode=skip" };

    case "aikey_init": {
      const probe = probeAikeyInit(cfg);
      if (probe.outcome !== "ok") {
        logger.warn("aikey_init.probe_fallback", { step: probe.step, reason: probe.reason });
        return { ...probe, outcome: "fallback" };
      }
      // Probe passed → real run.
      return runMakeSandbox({ sandboxPath, cfg, resolvedDir: probe.resolvedDir! });
    }

    case "copy_from_host":
      logger.warn("aikey_init.copy_from_host_not_in_m5b", {
        from: cfg.from ?? "~/.aikey",
        reason: "copy_from_host mode lands in a future milestone; use aikey_init",
      });
      return { outcome: "skip", step: 1, reason: "copy_from_host is deferred" };
  }
}

// ─── probe (4-step) ─────────────────────────────────────────────────────────

/**
 * 4-step probe. Pure: no fs writes. Step 4 is "ok to run" — actual run
 * happens in runMakeSandbox.
 */
export function probeAikeyInit(cfg: AikeySeedConfig): AikeyProbeResult {
  // Step 1: makefileDir resolved.
  const dir = cfg.aikeyMakefileDir;
  if (!dir || dir.length === 0) {
    return { outcome: "fallback", step: 1, reason: "aikeyMakefileDir not set" };
  }
  if (!fs.existsSync(dir)) {
    return { outcome: "fallback", step: 1, reason: `aikeyMakefileDir does not exist: ${dir}` };
  }

  // Step 2: Makefile present.
  const makefile = path.join(dir, "Makefile");
  if (!fs.existsSync(makefile)) {
    return { outcome: "fallback", step: 2, reason: `no Makefile at ${makefile}` };
  }

  // Step 3: `make -n sandbox` declares the target.
  const command = cfg.command ?? "make sandbox";
  const [tool, ...rest] = command.split(/\s+/);
  if (!tool) {
    return { outcome: "fallback", step: 3, reason: "command is empty" };
  }
  try {
    execFileSync(tool, ["-n", ...rest], {
      cwd: dir,
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    return {
      outcome: "fallback",
      step: 3,
      reason: `\`${tool} -n ${rest.join(" ")}\` failed in ${dir}: ${(err as Error).message}`,
      resolvedDir: dir,
    };
  }

  return { outcome: "ok", step: 4, reason: "probe ok (step 4 deferred to runMakeSandbox)", resolvedDir: dir };
}

// ─── real run (M5b) ─────────────────────────────────────────────────────────

interface RunOpts {
  sandboxPath: string;
  cfg: AikeySeedConfig;
  resolvedDir: string;
}

/**
 * Actually invoke `make sandbox -- --no-shell --sandbox-dir=<path>`. The
 * upstream sandbox_shell.py will:
 *   1. install aikey + aikey-proxy binaries into <path>/bin
 *   2. copy proxy config + patch vault path
 *   3. (when --key supplied) setup vault + store secret
 *   4. write <path>/work/_inited marker
 *   5. print SANDBOX_PATH=<path> to stdout
 *   6. exit 0 without spawning a shell
 *
 * On failure we throw with stderr captured for diagnosis. Common failures:
 *   - aikey CI deps not installed (pytest, pyyaml) → exit 1, hint
 *     `make -C <aikey-makefile-dir> install-deps` first
 *   - aikey binary not on PATH → sandbox_shell prints `'aikey' not found`
 *   - timeout → hung subprocess (rare)
 */
function runMakeSandbox(opts: RunOpts): AikeyProbeResult {
  const command = opts.cfg.command ?? "make sandbox";
  const [tool, ...makeArgs] = command.split(/\s+/);
  // Make passes everything after `--` to the underlying sandbox_shell.py
  // via the ARGS variable. We use ARGS=... form for portability across
  // make implementations (BSD / GNU).
  const argsVar = `--no-shell --sandbox-dir=${opts.sandboxPath}`;
  const r = spawnSync(tool!, [...makeArgs, `ARGS=${argsVar}`], {
    cwd: opts.resolvedDir,
    encoding: "utf8",
    timeout: opts.cfg.timeoutMs ?? 60_000,
    env: { ...process.env, ...opts.cfg.extraEnv },
  });

  if (r.status !== 0) {
    const stderr = (r.stderr ?? "").slice(0, 2048);
    const stdout = (r.stdout ?? "").slice(0, 512);
    // Likely-cause hint based on common failure signatures.
    let hint = "verify aikey makefile + dependencies are installed";
    if (/No module named '?pytest'?/i.test(stderr)) {
      hint = `aikey CI Python deps missing — run \`make -C ${opts.resolvedDir} install-deps\` first`;
    } else if (/'aikey' not found|aikey-proxy.*not found/i.test(stderr)) {
      hint = "aikey binary not on PATH — install aikey-cli or set AIKEY_TEST_DIST_DIR";
    } else if (/unrecognized arguments|--no-shell|--sandbox-dir/i.test(stderr)) {
      hint = "aikey sandbox_shell.py too old — update aikey to ship --no-shell + --sandbox-dir flags";
    }
    throw new TestableTerminalError(
      ErrorCode.SANDBOX_AIKEY_INIT_FAILED,
      `\`${command}\` failed (exit ${r.status}, signal ${r.signal ?? "-"}): ${stderr.trim() || "(no stderr)"}`,
      { hint, command, sandboxPath: opts.sandboxPath, stdoutHead: stdout, stderrTail: stderr.slice(-512) },
    );
  }

  // Verify marker exists. sandbox_shell.py writes it under <sandbox>/work/_inited.
  // We check both the spec'd location AND a flat <sandbox>/.aikey/_inited
  // for forward-compat with future aikey changes.
  const markers = [
    path.join(opts.sandboxPath, "work", "_inited"),
    path.join(opts.sandboxPath, ".aikey", "_inited"),
    path.join(opts.sandboxPath, "_inited"),
  ];
  const found = markers.find((p) => fs.existsSync(p));
  if (!found) {
    throw new TestableTerminalError(
      ErrorCode.SANDBOX_AIKEY_INIT_FAILED,
      `\`${command}\` returned exit 0 but no _inited marker found under ${opts.sandboxPath}`,
      { hint: "aikey sandbox_shell.py may have skipped seeding; check stdout", checkedPaths: markers },
    );
  }

  logger.info("aikey_init.real_run_ok", { sandboxPath: opts.sandboxPath, marker: found });
  return {
    outcome: "ok",
    step: 4,
    reason: `make sandbox bootstrapped successfully; marker at ${found}`,
    resolvedDir: opts.resolvedDir,
    sandboxPath: opts.sandboxPath,
  };
}
