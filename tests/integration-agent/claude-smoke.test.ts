/**
 * claude-smoke — real-agent smoke (RUN_REAL_AGENT_TESTS=1 to enable).
 *
 * Per spike-验证结果 §3 trap 6: assert on BEHAVIOR (model produces "15" for
 * a deterministic arithmetic prompt) rather than banner / version text.
 *
 * Routing: this Mac uses aikey shell wrappers (see _helpers.ts). With
 * loginShell=true, the spawn goes through `$SHELL -ilc 'exec claude ...'`
 * which loads zshrc → claude shell function → _aikey_preflight →
 * command claude. Provider keys come from aikey's vault, not env vars.
 */

import { it, expect, afterAll } from "vitest";
import { startSession } from "../../src/core/terminal-session.js";
import { __resetForTests as resetCleanup } from "../../src/core/process-cleanup.js";
import { describeIfReal, detectAikeyRouteFailure } from "./_helpers.js";

afterAll(() => { resetCleanup(); });

const TIMEOUT = 60_000;

describeIfReal("claude — real agent smoke", ["claude"], () => {
  it("answers 5 + 10 with 15 (claude --print, via aikey wrapper)", async () => {
    const session = await startSession({
      command: "claude",
      args: ["--print", "5 + 10 = ? Reply with just the number, nothing else."],
      rows: 24,
      cols: 100,
      loginShell: true,
      simulatePrecmdHooks: true, // ⬅ trigger aikey_precmd → active.env sourced
    });
    try {
      // Race three outcomes: success, known aikey-route failure, or process exit.
      const result = await Promise.race([
        session.waitForRegex(/\b15\b/, { timeoutMs: TIMEOUT }).then(() => "ok" as const),
        session.waitForExit({ timeoutMs: TIMEOUT }).then(() => "exit" as const),
      ]).catch(() => "timeout" as const);

      const aikeyIssue = detectAikeyRouteFailure(session.getCleanHistory(), result === "ok");
      if (aikeyIssue) throw new Error(`claude: ${aikeyIssue}`);
      if (result !== "ok") throw new Error(`claude did not produce "15" (race outcome: ${result})`);

      const snap = session.snapshot({ range: "all" });
      expect(snap.plainText).toMatch(/\b15\b/);
    } finally {
      await session.close();
    }
  }, TIMEOUT + 5_000);
});
