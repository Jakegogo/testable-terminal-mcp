/**
 * kimi-smoke — real-agent smoke for Moonshot Kimi CLI via aikey routing.
 *
 * Kimi's non-interactive mode:
 *   kimi --print --prompt "<prompt>"
 *
 * `--print` enables non-interactive output and implicitly adds `--yolo`
 * (skip approval prompts). Routing goes through whichever kimi alias is
 * active in aikey's vault.
 */

import { it, expect, afterAll } from "vitest";
import { startSession } from "../../src/core/terminal-session.js";
import { __resetForTests as resetCleanup } from "../../src/core/process-cleanup.js";
import { describeIfReal, detectAikeyRouteFailure } from "./_helpers.js";

afterAll(() => { resetCleanup(); });

const TIMEOUT = 60_000;

describeIfReal("kimi — real agent smoke", ["kimi"], () => {
  it("answers 5 + 10 with 15 (kimi --print, via aikey wrapper)", async () => {
    const session = await startSession({
      command: "kimi",
      args: ["--print", "--prompt", "5 + 10 = ? Reply with just the number, nothing else."],
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
      if (aikeyIssue) throw new Error(`kimi: ${aikeyIssue}`);
      if (result !== "ok") throw new Error(`kimi did not produce "15" (race outcome: ${result})`);

      const snap = session.snapshot({ range: "all" });
      expect(snap.plainText).toMatch(/\b15\b/);
    } finally {
      await session.close();
    }
  }, TIMEOUT + 5_000);
});
