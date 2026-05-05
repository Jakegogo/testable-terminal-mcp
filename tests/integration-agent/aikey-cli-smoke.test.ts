/**
 * aikey-cli-smoke — verifies aikey itself runs end-to-end through the PTY.
 *
 * Two cases here, both deterministic (no model involved):
 *
 *   1. `aikey status` — gateway health probe; output contains "Status" +
 *      "Gateway" and an HTTP listen URL. Verifies aikey is installed +
 *      proxy started.
 *
 *   2. `aikey list` — vault listing; output contains the section headers
 *      "Personal", "Team", "OAuth Accounts". Verifies vault auth +
 *      shell function dispatch.
 *
 * Both run via loginShell=true so the aikey shell function dispatches
 * (which exists on this Mac to handle activate/deactivate specially —
 * other commands fall through to `command aikey`).
 */

import { it, expect, afterAll } from "vitest";
import { startSession } from "../../src/core/terminal-session.js";
import { __resetForTests as resetCleanup } from "../../src/core/process-cleanup.js";
import { describeIfReal } from "./_helpers.js";

afterAll(() => { resetCleanup(); });

const TIMEOUT = 15_000;

describeIfReal("aikey — CLI smoke (deterministic, no model)", ["aikey"], () => {
  it("aikey status reports gateway health", async () => {
    const session = await startSession({
      command: "aikey",
      args: ["status"],
      rows: 30,
      cols: 100,
      loginShell: true,
    });
    try {
      await session.waitForExit({ timeoutMs: TIMEOUT });
      const stat = session.stats();
      expect(stat.exited).toBe(true);
      expect(stat.exitCode).toBe(0);
      const clean = session.getCleanHistory();
      // Aikey status output contains these markers reliably.
      expect(clean).toMatch(/Status/);
      expect(clean).toMatch(/Gateway/);
      // Listen URL appears (verifies proxy is up).
      expect(clean).toMatch(/listen:\s*http:\/\/127\.0\.0\.1:\d+/);
    } finally {
      await session.close();
    }
  }, TIMEOUT);

  it("aikey list shows configured keys (Personal / OAuth sections)", async () => {
    const session = await startSession({
      command: "aikey",
      args: ["list"],
      rows: 40,
      cols: 120,
      loginShell: true,
    });
    try {
      await session.waitForExit({ timeoutMs: TIMEOUT });
      const stat = session.stats();
      expect(stat.exited).toBe(true);
      expect(stat.exitCode).toBe(0);
      const clean = session.getCleanHistory();
      expect(clean).toMatch(/Personal/);
      expect(clean).toMatch(/OAuth Accounts/);
    } finally {
      await session.close();
    }
  }, TIMEOUT);
});
