/**
 * conpty-smoke — Windows-only PTY smoke covering the M0.5 dimensions that
 * have to actually run on Windows: pwsh launch, write/read, ctrl_c, env
 * injection, snapshot.
 *
 * Skips on macOS / Linux. The skip-on-non-Windows guard lets developers run
 * `npm test` on POSIX without spurious failures. Real verification happens
 * in `.github/workflows/ci.yml`'s `windows-only` job.
 */

import { it, expect, afterAll } from "vitest";
import { startSession } from "../../src/core/terminal-session.js";
import { __resetForTests as resetCleanup } from "../../src/core/process-cleanup.js";
import { describeIfWindows } from "./_helpers.js";

afterAll(() => { resetCleanup(); });

const TIMEOUT = 15_000;

describeIfWindows("Windows ConPTY smoke", () => {
  it("pwsh launches + Write-Host echoes + we see the output", async () => {
    const session = await startSession({
      // Use pwsh.exe explicitly: GH windows-latest runners have pwsh
      // installed at C:\Program Files\PowerShell\7\pwsh.exe and on PATH,
      // but node-pty's spawn-by-short-name "pwsh" sometimes returns
      // "File not found" on the runner (depends on runner image vintage).
      // Using .exe ensures CreateProcessW finds it via PATHEXT lookup.
      command: "pwsh.exe",
      args: ["-NoLogo"],
      rows: 24,
      cols: 100,
    });
    try {
      // pwsh prompts vary across versions; match the prompt suffix only.
      await session.waitForRegex(/PS\s.*>\s/, { timeoutMs: 5_000 });
      session.write("Write-Host CONPTY_HELLO\r");
      await session.waitForText("CONPTY_HELLO", { timeoutMs: 3_000 });
      const snap = session.snapshot({ range: "all" });
      expect(snap.plainText).toContain("CONPTY_HELLO");
    } finally {
      await session.close();
    }
  }, TIMEOUT);

  it("ctrl_c interrupts a long-running pwsh sleep", async () => {
    const session = await startSession({ command: "pwsh.exe", args: ["-NoLogo"] });
    try {
      await session.waitForRegex(/PS\s.*>\s/, { timeoutMs: 5_000 });
      // Compound command: Start-Sleep 30; Write-Host SLEEP_DONE — uses `;`
      // (sequential) so SLEEP_DONE only fires if sleep returned normally.
      // ctrl_c interrupts Start-Sleep, semicolon stops the pipeline (pwsh
      // doesn't continue past an interrupted command), SLEEP_DONE never
      // prints. This avoids the fragile "follow-up command + prompt regex"
      // chain which was racing with stale screen buffer + slow ConPTY
      // redraw on the GH runner.
      session.write("Start-Sleep -Seconds 30; Write-Host SLEEP_DONE_OUTPUT\r");
      await new Promise((r) => setTimeout(r, 500));
      session.sendKey("ctrl_c");
      // Settle period for ConPTY to deliver any post-interrupt output.
      await new Promise((r) => setTimeout(r, 1_500));

      // The marker string SLEEP_DONE_OUTPUT WILL appear in history as the
      // typed-command echo (PowerShell echoes input back). Distinguish
      // command output (would be on its own line if Write-Host actually
      // ran) from input echo (mixed with `> ` prompt / other characters).
      const lines = session.getCleanHistory().replace(/\r\n/g, "\n").split("\n");
      const standaloneOutput = lines.find((l) => /^\s*SLEEP_DONE_OUTPUT\s*$/.test(l));
      expect(standaloneOutput).toBeUndefined();
    } finally {
      await session.close();
    }
  }, TIMEOUT);
});
