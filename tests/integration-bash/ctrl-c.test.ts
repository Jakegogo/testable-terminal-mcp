/**
 * Ctrl-C interrupt integration test.
 *
 * Goal: a long-running foreground command (sleep 30) interrupted with
 * sendKey("ctrl_c") returns control to the prompt within ~1s and the
 * subsequent `echo AFTER` runs to completion. Tests the full path:
 *
 *   sendKey('ctrl_c') → KEY_SEQUENCES['ctrl_c'] = "\x03"
 *   → proc.write       → PTY signals SIGINT to fg process
 *   → bash regains control + reprints prompt
 *   → next write() works normally
 *
 * This guards against accidentally re-routing ctrl_c through anything that
 * would swallow the byte (e.g. a paste-bracketed wrap path).
 */

import { describe, it, expect, afterAll } from "vitest";
import { startSession } from "../../src/core/terminal-session.js";
import { __resetForTests as resetCleanup } from "../../src/core/process-cleanup.js";

afterAll(() => { resetCleanup(); });

describe("bash integration — ctrl-c interrupt", () => {
  it("ctrl_c interrupts long-running sleep, prompt resumes", async () => {
    const session = await startSession({ command: "bash", rows: 24, cols: 80 });
    try {
      await session.waitForRegex(/\$\s/, { timeoutMs: 3_000 });

      // Kick off a 30s sleep in the foreground; `&&` ensures SLEEP_DONE
      // only fires if sleep exits 0 — when SIGINT kills sleep, the && short-
      // circuits and SLEEP_DONE never runs. (Using `;` would keep running
      // the echo even after ctrl-c, since ; is sequential not conditional.)
      // Note: SLEEP_DONE will appear in raw history as the typed input echo,
      // but never on its own line as command output.
      session.write("sleep 30 && echo SLEEP_DONE_OUTPUT\n");

      // Tiny delay so bash actually starts the sleep before we interrupt.
      // (Without this, ctrl_c can hit the prompt redraw and miss the child.)
      await new Promise((r) => setTimeout(r, 200));

      session.sendKey("ctrl_c");

      // After interrupt, bash prints a fresh prompt; we should see it within 2s.
      await session.waitForRegex(/\$\s/, { timeoutMs: 2_000 });

      // Sanity: SLEEP_DONE_OUTPUT must NOT appear as command output.
      // Wait a moment to let any in-flight stdout drain.
      await new Promise((r) => setTimeout(r, 200));
      // The echo of the typed command line also contains the marker; we
      // distinguish actual output by checking it does NOT appear on a line
      // that starts with the marker (output) vs a line containing
      // "echo SLEEP_DONE_OUTPUT" (typed input echo).
      const lines = session.getCleanHistory().split(/\r?\n/);
      const standaloneOutput = lines.find((l) => /^SLEEP_DONE_OUTPUT\s*$/.test(l));
      expect(standaloneOutput).toBeUndefined();

      // And the prompt is responsive to a follow-up command.
      session.write("echo AFTER_CTRLC\n");
      await session.waitForRegex(/AFTER_CTRLC/, { timeoutMs: 2_000 });
    } finally {
      await session.close();
    }
  }, 15_000);

  it("input.key event is recorded for sendKey", async () => {
    const session = await startSession({ command: "bash" });
    try {
      await session.waitForRegex(/\$\s/, { timeoutMs: 3_000 });
      session.sendKey("ctrl_c");
      // Brief settle so the event is in the buffer.
      await new Promise((r) => setTimeout(r, 50));
      const evs = session.getEvents();
      const keyEvents = evs.filter((e) => e.type === "input.key");
      expect(keyEvents.length).toBeGreaterThan(0);
      expect((keyEvents[keyEvents.length - 1]!.data as { key: string }).key).toBe("ctrl_c");
    } finally {
      await session.close();
    }
  }, 10_000);
});
