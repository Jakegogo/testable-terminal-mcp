/**
 * M4 acceptance test #1 — parallel sandbox isolation.
 *
 * Two sandboxes spawn bash sessions concurrently; each session sees its own
 * $HOME / $PATH; host's ~/ is untouched throughout. This is the highest-value
 * acceptance signal for the whole sandbox layer: if this passes the env
 * plumbing is wired correctly end-to-end.
 */

import { describe, it, expect, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { startSession } from "../../src/core/terminal-session.js";
import { createSandbox, __resetForTests as resetMgr } from "../../src/core/sandbox/manager.js";
import { __resetForTests as resetCleanup } from "../../src/core/process-cleanup.js";

afterAll(() => { resetCleanup(); resetMgr(); });

const TIMEOUT = 15_000;

describe("sandbox integration — parallel isolation", () => {
  it("two sandboxes have distinct $HOME visible from inside bash", async () => {
    const a = createSandbox({
      config: { mode: "ephemeral" },
      manager: { maxConcurrentSandboxes: 4, skipSignalHooks: true },
    });
    const b = createSandbox({
      config: { mode: "ephemeral" },
      manager: { maxConcurrentSandboxes: 4, skipSignalHooks: true },
    });

    const sa = await startSession({ command: "bash", sandbox: a });
    const sb = await startSession({ command: "bash", sandbox: b });

    try {
      await Promise.all([
        sa.waitForRegex(/\$\s/, { timeoutMs: 3_000 }),
        sb.waitForRegex(/\$\s/, { timeoutMs: 3_000 }),
      ]);
      sa.write("echo HOME_IS=$HOME\n");
      sb.write("echo HOME_IS=$HOME\n");

      // Each session should report its own sandbox path.
      await sa.waitForRegex(new RegExp(`HOME_IS=${escapeRe(a.path)}\\b`), { timeoutMs: 3_000 });
      await sb.waitForRegex(new RegExp(`HOME_IS=${escapeRe(b.path)}\\b`), { timeoutMs: 3_000 });

      // Cross-check: A's snapshot must NOT contain B's path.
      const snapA = sa.getCleanHistory();
      const snapB = sb.getCleanHistory();
      expect(snapA).toContain(a.path);
      expect(snapA).not.toContain(b.path);
      expect(snapB).toContain(b.path);
      expect(snapB).not.toContain(a.path);
    } finally {
      await Promise.all([sa.close(), sb.close()]);
    }
  }, TIMEOUT);

  it("sandbox bin/ is the first PATH entry visible to the shell", async () => {
    const sb = createSandbox({
      config: { mode: "ephemeral" },
      manager: { maxConcurrentSandboxes: 4, skipSignalHooks: true },
    });
    const session = await startSession({ command: "bash", sandbox: sb });
    try {
      await session.waitForRegex(/\$\s/, { timeoutMs: 3_000 });
      session.write('echo FIRST_PATH=${PATH%%:*}\n');
      await session.waitForRegex(new RegExp(`FIRST_PATH=${escapeRe(sb.path)}/bin\\b`), { timeoutMs: 3_000 });
    } finally {
      await session.close();
    }
  }, TIMEOUT);

  it("host ~/ is not modified by sandbox session activity", async () => {
    const before = fs.readdirSync(os.homedir()).sort();
    const sb = createSandbox({
      config: { mode: "ephemeral" },
      manager: { maxConcurrentSandboxes: 4, skipSignalHooks: true },
    });
    const session = await startSession({ command: "bash", sandbox: sb });
    try {
      await session.waitForRegex(/\$\s/, { timeoutMs: 3_000 });
      // Touch a file inside the sandbox — must not leak to host home.
      session.write("touch SANDBOX_TOUCHED && ls\n");
      await session.waitForRegex(/SANDBOX_TOUCHED/, { timeoutMs: 3_000 });
      // File appears under sandbox path...
      expect(fs.existsSync(path.join(sb.path, "SANDBOX_TOUCHED"))).toBe(true);
      // ...but not under host HOME.
      expect(fs.existsSync(path.join(os.homedir(), "SANDBOX_TOUCHED"))).toBe(false);
      const after = fs.readdirSync(os.homedir()).sort();
      expect(after).toEqual(before);
    } finally {
      await session.close();
    }
  }, TIMEOUT);
});

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
