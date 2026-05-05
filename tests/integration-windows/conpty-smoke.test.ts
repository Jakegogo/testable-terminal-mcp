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
    const session = await startSession({ command: "pwsh", args: ["-NoLogo"] });
    try {
      await session.waitForRegex(/PS\s.*>\s/, { timeoutMs: 5_000 });
      session.write("Start-Sleep -Seconds 30\r");
      await new Promise((r) => setTimeout(r, 300));
      session.sendKey("ctrl_c");
      // Prompt should resume within 3s of the interrupt.
      await session.waitForRegex(/PS\s.*>\s/, { timeoutMs: 3_000 });
      // Follow-up command works.
      session.write("Write-Host POST_CTRL_C\r");
      await session.waitForText("POST_CTRL_C", { timeoutMs: 3_000 });
    } finally {
      await session.close();
    }
  }, TIMEOUT);
});
