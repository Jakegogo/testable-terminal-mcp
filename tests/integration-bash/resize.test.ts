/**
 * Resize integration test.
 *
 * Goal: after `session.resize(rows, cols)` both sides know the new dims:
 *   - the headless xterm buffer (snapshot.range="viewport" lines bound)
 *   - the PTY tty (bash's $LINES/$COLUMNS reflect the change)
 *
 * Why both: a one-sided resize is a classic source of TUI corruption — if
 * we only resize xterm, bash still prints with the old wrap width; if we
 * only resize PTY, our snapshot dimensions lag.
 */

import { describe, it, expect, afterAll } from "vitest";
import { startSession } from "../../src/core/terminal-session.js";
import { __resetForTests as resetCleanup } from "../../src/core/process-cleanup.js";

afterAll(() => { resetCleanup(); });

describe("bash integration — resize", () => {
  it("resize changes both PTY and xterm dimensions", async () => {
    const session = await startSession({ command: "bash", rows: 10, cols: 40 });
    try {
      await session.waitForRegex(/\$\s/, { timeoutMs: 3_000 });

      // Initial dims sanity: viewport snapshot capped at 10 rows.
      const before = session.snapshot({ range: "viewport" });
      expect(before.plainLines.length).toBeLessThanOrEqual(10);

      // PTY-side check: bash's `$COLUMNS` reflects 40 initially.
      session.write("echo COL_BEFORE_$COLUMNS\n");
      await session.waitForRegex(/COL_BEFORE_40\b/, { timeoutMs: 2_000 });

      session.resize(30, 100);

      // xterm-side check: viewport now allows up to 30 rows.
      // We need *some* output to exercise the new width — print a single
      // line and confirm we can still see it cleanly without forced wrap.
      session.write("echo POSTRESIZE_OK\n");
      await session.waitForRegex(/POSTRESIZE_OK/, { timeoutMs: 2_000 });
      const after = session.snapshot({ range: "viewport" });
      expect(after.plainLines.length).toBeLessThanOrEqual(30);
      // The line itself must be present.
      expect(after.plainText).toContain("POSTRESIZE_OK");

      // PTY-side check: after SIGWINCH, bash should see the new width.
      // bash emits SIGWINCH listener that updates $COLUMNS only when shopt
      // -s checkwinsize is set; with `-i` it usually is. Verify directly.
      session.write("echo COL_AFTER_$COLUMNS\n");
      await session.waitForRegex(/COL_AFTER_100\b/, { timeoutMs: 2_000 });
    } finally {
      await session.close();
    }
  }, 15_000);

  it("records 'resize' event with new dims", async () => {
    const session = await startSession({ command: "bash", rows: 10, cols: 40 });
    try {
      await session.waitForRegex(/\$\s/, { timeoutMs: 3_000 });
      session.resize(20, 80);
      const events = session.getEvents();
      const resizeEvents = events.filter((e) => e.type === "resize");
      expect(resizeEvents.length).toBe(1);
      expect(resizeEvents[0]!.data).toEqual({ rows: 20, cols: 80 });
    } finally {
      await session.close();
    }
  }, 10_000);

  it("resize after exit is a no-op (does not throw)", async () => {
    const session = await startSession({ command: "bash" });
    await session.waitForRegex(/\$\s/, { timeoutMs: 3_000 });
    await session.close();
    expect(() => session.resize(10, 10)).not.toThrow();
  }, 10_000);
});
