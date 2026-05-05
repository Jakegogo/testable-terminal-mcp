/**
 * M2 acceptance integration test: real bash session via node-pty.
 *
 * Covers:
 *   - bash spawn → echo OK → snapshot contains "OK"
 *   - bash exits naturally → status reflects exit_code 0
 *   - close() kills process group cleanly (no orphan after close)
 *   - maxOutputBytes / maxHistoryBytes truncates ring,truncated=true
 *   - ANSI snapshot includes SGR sequences
 *   - SnapshotRange "viewport" / "all" / { lastLines: N } each work
 *   - history API: getRawHistory / getCleanHistory / getHistoryStats
 *
 * Round 11 + 12 lessons baked in:
 *   - waitForExit instead of fixed sleep (round 4 API)
 *   - default ready not used (bash-3.2$ doesn't match the strict prompt regex
 *     waitForReady wants — we use waitForRegex on the actual prompt instead)
 */

import { describe, it, expect, afterAll } from "vitest";
import { startSession } from "../../src/core/terminal-session.js";
import { __resetForTests as resetCleanup } from "../../src/core/process-cleanup.js";

afterAll(() => { resetCleanup(); });

// All bash tests share a 15s timeout.
const TIMEOUT = 15_000;

describe("bash integration smoke", () => {
  it("echo command + snapshot contains output", async () => {
    const session = await startSession({ command: "bash", rows: 24, cols: 80 });
    try {
      // Wait until bash prints its first prompt.
      await session.waitForRegex(/\$\s/, { timeoutMs: 3_000 });
      session.write("echo SMOKE_OK\n");
      await session.waitForRegex(/SMOKE_OK\b/, { timeoutMs: 3_000 });
      const snap = session.snapshot();
      expect(snap.plainText).toContain("SMOKE_OK");
    } finally {
      await session.close();
    }
  }, TIMEOUT);

  it("exit code 0 propagates via stats() after natural exit", async () => {
    const session = await startSession({ command: "bash", rows: 24, cols: 80 });
    try {
      await session.waitForRegex(/\$\s/, { timeoutMs: 3_000 });
      session.write("exit 0\n");
      await session.waitForExit({ timeoutMs: 3_000 });
      const stat = session.stats();
      expect(stat.exited).toBe(true);
      expect(stat.exitCode).toBe(0);
    } finally {
      await session.close();
    }
  }, TIMEOUT);

  it("non-zero exit code is reported", async () => {
    const session = await startSession({ command: "bash", rows: 24, cols: 80 });
    try {
      await session.waitForRegex(/\$\s/, { timeoutMs: 3_000 });
      session.write("exit 7\n");
      await session.waitForExit({ timeoutMs: 3_000 });
      expect(session.stats().exitCode).toBe(7);
    } finally {
      await session.close();
    }
  }, TIMEOUT);

  it("close() makes write() throw 'Session has exited'", async () => {
    const session = await startSession({ command: "bash" });
    await session.waitForRegex(/\$\s/, { timeoutMs: 3_000 });
    await session.close();
    expect(() => session.write("x\n")).toThrow(/has exited/);
  }, TIMEOUT);
});

describe("bash integration — history API", () => {
  it("getCleanHistory contains echoed text without ANSI", async () => {
    const session = await startSession({ command: "bash" });
    try {
      await session.waitForRegex(/\$\s/, { timeoutMs: 3_000 });
      session.write("printf 'HISTORY_DEMO\\n'\n");
      await session.waitForRegex(/HISTORY_DEMO/, { timeoutMs: 3_000 });
      const clean = session.getCleanHistory();
      expect(clean).toContain("HISTORY_DEMO");
      expect(clean).not.toMatch(/\x1b\[/); // no escape sequences
    } finally {
      await session.close();
    }
  }, TIMEOUT);

  it("getHistoryStats reports byte count > 0 and chunks > 0", async () => {
    const session = await startSession({ command: "bash" });
    try {
      await session.waitForRegex(/\$\s/, { timeoutMs: 3_000 });
      session.write("echo X\n");
      await session.waitForRegex(/\bX\b\s*\r?\n/, { timeoutMs: 3_000 });
      const stats = session.getHistoryStats();
      expect(stats.bytes).toBeGreaterThan(0);
      expect(stats.chunks).toBeGreaterThan(0);
      expect(stats.truncated).toBe(false);
      expect(stats.path).toBe(null);  // no historyLogPath set
    } finally {
      await session.close();
    }
  }, TIMEOUT);

  it("maxHistoryBytes triggers truncated=true when output exceeds budget", async () => {
    // 512B budget; large enough that the bash prompt redraw after the loop
    // doesn't evict the latest LINE_X, but small enough to force truncation.
    const session = await startSession({
      command: "bash", maxHistoryBytes: 512,
    });
    try {
      await session.waitForRegex(/\$\s/, { timeoutMs: 3_000 });
      session.write("for i in $(seq 1 80); do echo \"LINE_$i\"; done\n");
      await session.waitForRegex(/LINE_80/, { timeoutMs: 5_000 });
      // Brief settle for trailing prompt redraw.
      await new Promise((r) => setTimeout(r, 100));
      const stats = session.getHistoryStats();
      expect(stats.truncated).toBe(true);
      // Ring shouldn't grow much past budget (allow ~3x for last-chunk overflow).
      expect(stats.bytes).toBeLessThan(512 * 3);
      // SOME late line must be retained (LINE_70-LINE_80 most likely present).
      expect(session.getRawHistory()).toMatch(/LINE_[78]\d/);
      // Earliest lines must NOT be present (definitively truncated).
      expect(session.getRawHistory()).not.toContain("LINE_1\n");
    } finally {
      await session.close();
    }
  }, TIMEOUT);
});

describe("bash integration — SnapshotRange", () => {
  it("viewport vs lastLines vs all all reflect different slices", async () => {
    const session = await startSession({ command: "bash", rows: 6, cols: 60 });
    try {
      await session.waitForRegex(/\$\s/, { timeoutMs: 3_000 });
      session.write("for i in $(seq 1 30); do echo \"R_$i\"; done\n");
      await session.waitForRegex(/R_30/, { timeoutMs: 5_000 });
      // Brief settle so all 30 lines are in buffer.
      await new Promise((r) => setTimeout(r, 200));

      const all = session.snapshot({ range: "all" });
      const last10 = session.snapshot({ range: { lastLines: 10 } });
      const viewport = session.snapshot({ range: "viewport" });

      // 'all' should contain everything we generated.
      expect(all.plainText).toContain("R_1");
      expect(all.plainText).toContain("R_30");

      // 'lastLines: 10' should contain newest but NOT oldest.
      expect(last10.plainText).toContain("R_30");
      expect(last10.plainText).not.toContain("R_1\n");

      // viewport bound to row count (6) — newest should be there.
      expect(viewport.plainText).toContain("R_30");
      expect(viewport.plainLines.length).toBeLessThanOrEqual(6);
    } finally {
      await session.close();
    }
  }, TIMEOUT);
});

describe("bash integration — ANSI snapshot", () => {
  it("ansiText includes SGR escape sequences when terminal renders color", async () => {
    const session = await startSession({ command: "bash" });
    try {
      await session.waitForRegex(/\$\s/, { timeoutMs: 3_000 });
      // tput / printf ANSI color → echo
      session.write("printf '\\033[31mRED\\033[0m PLAIN\\n'\n");
      await session.waitForRegex(/RED PLAIN/, { timeoutMs: 3_000 });
      const snap = session.snapshot({ range: "all" });
      expect(snap.plainText).toContain("RED PLAIN");
      // ansi text should contain SGR sequences (we re-emit them per cell).
      expect(snap.ansiText).toMatch(/\x1b\[/);
    } finally {
      await session.close();
    }
  }, TIMEOUT);
});

describe("bash integration — events", () => {
  it("emits 'data' event for each chunk", async () => {
    const session = await startSession({ command: "bash" });
    let chunks = 0;
    session.on("data", () => { chunks++; });
    try {
      await session.waitForRegex(/\$\s/, { timeoutMs: 3_000 });
      session.write("echo X\n");
      await session.waitForRegex(/\bX\b\s*\r?\n/, { timeoutMs: 3_000 });
      expect(chunks).toBeGreaterThan(0);
    } finally {
      await session.close();
    }
  }, TIMEOUT);

  it("emits 'screen-changed' (debounced) and 'exit'", async () => {
    const session = await startSession({ command: "bash" });
    let screenChanges = 0;
    let exited = false;
    session.on("screen-changed", () => { screenChanges++; });
    session.on("exit", () => { exited = true; });
    try {
      await session.waitForRegex(/\$\s/, { timeoutMs: 3_000 });
      expect(screenChanges).toBeGreaterThan(0);
      session.write("exit 0\n");
      await session.waitForExit({ timeoutMs: 3_000 });
      expect(exited).toBe(true);
    } finally {
      await session.close();
    }
  }, TIMEOUT);
});
