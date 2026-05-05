/**
 * codex-smoke — real-agent smoke for OpenAI Codex CLI via aikey routing.
 *
 * Codex's non-interactive mode is the `exec` subcommand:
 *   codex exec "<prompt>"
 *
 * Routing goes through aikey's `openai` provider (configured via
 * `aikey use openai`).
 */

import { it, expect, afterAll } from "vitest";
import { startSession } from "../../src/core/terminal-session.js";
import { __resetForTests as resetCleanup } from "../../src/core/process-cleanup.js";
import { describeIfReal, detectAikeyRouteFailure } from "./_helpers.js";

afterAll(() => { resetCleanup(); });

const TIMEOUT = 60_000;

describeIfReal("codex — real agent smoke", ["codex"], () => {
  it("answers 5 + 10 with 15 (codex exec, via aikey wrapper)", async () => {
    const session = await startSession({
      command: "codex",
      args: ["exec", "5 + 10 = ? Reply with just the number, nothing else."],
      rows: 24,
      cols: 100,
      loginShell: true,
      simulatePrecmdHooks: true,
    });
    try {
      const result = await Promise.race([
        session.waitForRegex(/\b15\b/, { timeoutMs: TIMEOUT }).then(() => "ok" as const),
        session.waitForExit({ timeoutMs: TIMEOUT }).then(() => "exit" as const),
      ]).catch(() => "timeout" as const);

      const aikeyIssue = detectAikeyRouteFailure(session.getCleanHistory(), result === "ok");
      if (aikeyIssue) throw new Error(`codex: ${aikeyIssue}`);
      if (result !== "ok") throw new Error(`codex did not produce "15" (race outcome: ${result})`);

      const snap = session.snapshot({ range: "all" });
      expect(snap.plainText).toMatch(/\b15\b/);
    } finally {
      await session.close();
    }
  }, TIMEOUT + 5_000);
});
