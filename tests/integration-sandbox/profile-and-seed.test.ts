/**
 * M4 acceptance test #3 — profile / seed file behavior visible from inside.
 *
 *   - host-zshrc profile copies host dotfiles (test via fake hostHome dir
 *     would need a manager hook; instead we use seed.files for deterministic
 *     content delivery).
 *   - seed.files content is readable from inside the sandbox.
 *   - macOS Library/ placeholders exist as empty dirs.
 *   - Windows skip handled in unit tests; this file targets POSIX runtime.
 */

import { describe, it, expect, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { startSession } from "../../src/core/terminal-session.js";
import { createSandbox, __resetForTests as resetMgr } from "../../src/core/sandbox/manager.js";
import { __resetForTests as resetCleanup } from "../../src/core/process-cleanup.js";
import { platform as hostPlatform } from "../../src/core/platform.js";

afterAll(() => { resetCleanup(); resetMgr(); });

const TIMEOUT = 15_000;

describe("sandbox integration — profile + seed", () => {
  it("seed.files content is readable from inside the sandbox shell", async () => {
    // bash login order is .bash_profile → .bash_login → .profile, then .bashrc
    // only on non-login interactive. With our `-il` wrapper we get login
    // interactive, so seed .bash_profile (not .bashrc) for deterministic
    // sourcing across macOS / Linux.
    const sb = createSandbox({
      config: {
        mode: "ephemeral",
        seed: { files: { ".bash_profile": 'export FROM_SEED="seeded-value"\n' } },
      },
      manager: { maxConcurrentSandboxes: 4, skipSignalHooks: true },
    });
    const session = await startSession({ command: "bash", sandbox: sb, loginShell: true });
    try {
      await session.waitForRegex(/\$\s/, { timeoutMs: 3_000 });
      session.write('echo SEED=[$FROM_SEED]\n');
      await session.waitForRegex(/SEED=\[seeded-value\]/, { timeoutMs: 3_000 });
    } finally {
      await session.close();
    }
  }, TIMEOUT);

  it("macOS / Linux Library/ placeholders exist after create", async () => {
    if (hostPlatform.isWindows) return; // covered in unit tests
    const sb = createSandbox({
      config: { mode: "ephemeral", profile: "minimal" },
      manager: { maxConcurrentSandboxes: 4, skipSignalHooks: true },
    });
    expect(fs.existsSync(path.join(sb.path, "Library/Application Support"))).toBe(true);
    expect(fs.existsSync(path.join(sb.path, "Library/Caches"))).toBe(true);
    expect(fs.existsSync(path.join(sb.path, "Library/Preferences"))).toBe(true);
    // _meta.json is reachable from inside session via $HOME/_meta.json.
    const session = await startSession({ command: "bash", sandbox: sb });
    try {
      await session.waitForRegex(/\$\s/, { timeoutMs: 3_000 });
      session.write('test -f $HOME/_meta.json && echo META_PRESENT\n');
      await session.waitForRegex(/META_PRESENT/, { timeoutMs: 3_000 });
    } finally {
      await session.close();
    }
  }, TIMEOUT);

  it("default cwd is the sandbox path when caller doesn't pin", async () => {
    const sb = createSandbox({
      config: { mode: "ephemeral" },
      manager: { maxConcurrentSandboxes: 4, skipSignalHooks: true },
    });
    const session = await startSession({ command: "bash", sandbox: sb });
    try {
      await session.waitForRegex(/\$\s/, { timeoutMs: 3_000 });
      session.write("pwd\n");
      // pwd may resolve symlinks (macOS /var → /private/var), so we only
      // confirm the trailing path component matches the mkdtemp basename.
      const baseName = path.basename(sb.path);
      await session.waitForRegex(new RegExp(`/${escapeRe(baseName)}\\b`), { timeoutMs: 3_000 });
    } finally {
      await session.close();
    }
  }, TIMEOUT);
});

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
