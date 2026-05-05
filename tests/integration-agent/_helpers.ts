/**
 * Helpers for real-agent smoke tests.
 *
 * Gating: RUN_REAL_AGENT_TESTS=1 must be set; otherwise tests skip cleanly.
 *
 * Aikey integration:
 *   On this Mac, `claude` / `codex` / `kimi` / `aikey` are zsh shell
 *   functions (defined in user's zshrc) that wrap the real binaries with
 *   aikey-routed pre-flight (proxy ensure-running, key-use validation).
 *   The functions are NOT visible to a bare `pty.spawn("claude")` call
 *   because that does a syscall-level exec on the underlying binary,
 *   bypassing the shell-side aikey routing.
 *
 *   Solution: spawn through `loginShell: true` so shell-wrap.ts wraps the
 *   command as `$SHELL -ilc 'exec <cmd>'`. The login shell sources zshrc,
 *   the function is defined, and `exec claude` calls the wrapper which
 *   talks to aikey's local proxy (default 127.0.0.1:27200). Provider keys
 *   come from aikey's vault — no env-var keys needed.
 */

import { describe } from "vitest";
import { execSync } from "node:child_process";

const ENABLED = process.env.RUN_REAL_AGENT_TESTS === "1";

/**
 * Run via `<shell> -ilc <cmd>` so aikey's zsh function wrappers are
 * available. We use the user's $SHELL (zsh on Mac) to match what the
 * Session test path will use at runtime.
 */
export function loginShellExec(cmd: string): string {
  const shell = process.env.SHELL || "/bin/zsh";
  return execSync(`${shell} -ilc ${JSON.stringify(cmd)}`, { encoding: "utf8", timeout: 5_000 });
}

/** Check if a binary is reachable through the user's login shell. */
export function loginShellHas(bin: string): boolean {
  try {
    loginShellExec(`command -v ${bin} >/dev/null 2>&1 && echo OK`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Wrap a describe block with the real-agent gate.
 *
 * @param requiredBinaries — checked via login shell (aikey wrappers count).
 *                          If any is missing, the suite skips with the
 *                          missing binary listed in the skip reason.
 */
export function describeIfReal(
  name: string,
  requiredBinaries: ReadonlyArray<string>,
  fn: () => void,
): void {
  if (!ENABLED) {
    describe.skip(`${name} (RUN_REAL_AGENT_TESTS!=1)`, fn);
    return;
  }
  const missing = requiredBinaries.filter((b) => !loginShellHas(b));
  if (missing.length > 0) {
    describe.skip(`${name} (missing binaries on login shell: ${missing.join(", ")})`, fn);
    return;
  }
  describe(name, fn);
}

export const REAL_AGENT_ENABLED = ENABLED;

// ─── shared aikey-routing detection ─────────────────────────────────────────

/**
 * Hard-failure patterns: presence in output means the request actually
 * failed at upstream API or env-injection layer. Surface these as test
 * failures with actionable fix.
 *
 * NOTE: "no active binding" is intentionally NOT here — it's a soft
 * warning. Claude with an active OAuth session works even when no API-key
 * binding is set (preflight skips → OAuth path takes over). We only treat
 * it as a failure if the model didn't produce output (handled by caller).
 */
export const AIKEY_HARD_FAILURE_PATTERNS: Array<{ re: RegExp; reason: string; fix: string }> = [
  {
    re: /Error code:\s*401/,
    reason: "upstream API returned 401 — configured key is invalid or expired",
    fix: "run `aikey list`, then `aikey use <valid-alias>` for the target provider",
  },
  {
    re: /Missing environment variable:\s*([A-Z_]+_API_KEY)/,
    reason: "client expected env var that aikey preflight should have injected",
    fix: "verify aikey proxy is healthy (`aikey status`) and the active key matches this client's protocol",
  },
  {
    re: /LLM not set/,
    reason: "kimi reports no LLM configured for this active key",
    fix: "the active kimi key likely has no model attached; try a different alias via `aikey use <other-kimi>`",
  },
];

/** Soft-warning patterns. Only flag as failure when no model output produced. */
export const AIKEY_SOFT_WARNING_PATTERNS: Array<{ re: RegExp; reason: string; fix: string }> = [
  {
    re: /\[aikey\]\s*no active binding/,
    reason: "aikey preflight skipped — no active binding for this provider's protocol",
    fix: "run `aikey use <alias>` (alias whose protocol matches this client). For Anthropic OAuth, this can be safely ignored if model output is correct.",
  },
];

/**
 * Detect aikey routing failures based on output AND whether model output
 * was successfully captured.
 *
 * @param output    captured terminal output (clean history)
 * @param producedOutput true if the test's success regex already matched
 *                       (e.g., "15" was seen). Soft warnings are then
 *                       suppressed; only hard failures throw.
 */
export function detectAikeyRouteFailure(output: string, producedOutput = false): string | null {
  // Hard failures fire regardless — these are upstream errors that
  // co-occurred with output (rare but possible) AND when there's no output.
  for (const p of AIKEY_HARD_FAILURE_PATTERNS) {
    if (p.re.test(output)) {
      return `aikey routing not ready: ${p.reason}\nFix: ${p.fix}\nOutput tail:\n${output.slice(-512)}`;
    }
  }
  // Soft warnings only matter when there's no successful output.
  if (!producedOutput) {
    for (const p of AIKEY_SOFT_WARNING_PATTERNS) {
      if (p.re.test(output)) {
        return `aikey routing not ready: ${p.reason}\nFix: ${p.fix}\nOutput tail:\n${output.slice(-512)}`;
      }
    }
  }
  return null;
}
