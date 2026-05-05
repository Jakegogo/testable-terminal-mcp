/**
 * M4 acceptance test #2 — three envInheritance modes drive distinct env in
 * the live shell.
 *
 *   whitelist:       only listed keys come through
 *   all_with_overlay: host EDITOR=vi → session EDITOR=vi
 *   none:            session EDITOR is empty
 *
 * Plus denyKeys: even in all_with_overlay, ANTHROPIC_API_KEY from host is
 * blocked.
 */

import { describe, it, expect, afterAll } from "vitest";
import { startSession } from "../../src/core/terminal-session.js";
import { createSandbox, __resetForTests as resetMgr } from "../../src/core/sandbox/manager.js";
import { __resetForTests as resetCleanup } from "../../src/core/process-cleanup.js";

afterAll(() => { resetCleanup(); resetMgr(); });

const TIMEOUT = 15_000;

describe("sandbox integration — envInheritance modes", () => {
  it("all_with_overlay (default): host EDITOR visible, ANTHROPIC_API_KEY blocked", async () => {
    // Inject controlled host env via process.env mutation for this test.
    const prev = { EDITOR: process.env.EDITOR, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY };
    process.env.EDITOR = "vi-host";
    process.env.ANTHROPIC_API_KEY = "sk-ant-host-secret";
    try {
      const sb = createSandbox({
        config: { mode: "ephemeral" },
        manager: { maxConcurrentSandboxes: 4, skipSignalHooks: true },
      });
      const session = await startSession({ command: "bash", sandbox: sb });
      try {
        await session.waitForRegex(/\$\s/, { timeoutMs: 3_000 });

        session.write('echo EDITOR_IS=[$EDITOR] KEY_IS=[$ANTHROPIC_API_KEY]\n');
        await session.waitForRegex(/EDITOR_IS=\[vi-host\]/, { timeoutMs: 3_000 });
        // ANTHROPIC_API_KEY must be empty (denyKeys default blocks it).
        await session.waitForRegex(/KEY_IS=\[\]/, { timeoutMs: 3_000 });
      } finally {
        await session.close();
      }
    } finally {
      restoreEnv(prev);
    }
  }, TIMEOUT);

  it("whitelist: only LANG passes, EDITOR is empty", async () => {
    const prev = { EDITOR: process.env.EDITOR, LANG: process.env.LANG };
    process.env.EDITOR = "vi-host";
    process.env.LANG = "en_US.UTF-8";
    try {
      const sb = createSandbox({
        config: { mode: "ephemeral" },
        manager: { maxConcurrentSandboxes: 4, skipSignalHooks: true },
      });
      const session = await startSession({
        command: "bash",
        sandbox: sb,
        envInheritance: { mode: "whitelist" },
        passthroughEnvKeys: ["LANG"],
      });
      try {
        await session.waitForRegex(/\$\s/, { timeoutMs: 3_000 });
        session.write('echo EDITOR_IS=[$EDITOR] LANG_IS=[$LANG]\n');
        await session.waitForRegex(/LANG_IS=\[en_US\.UTF-8\]/, { timeoutMs: 3_000 });
        await session.waitForRegex(/EDITOR_IS=\[\]/, { timeoutMs: 3_000 });
      } finally {
        await session.close();
      }
    } finally {
      restoreEnv(prev);
    }
  }, TIMEOUT);

  it("none: even host EDITOR empty; PATH contains only sandbox bins", async () => {
    const prev = { EDITOR: process.env.EDITOR };
    process.env.EDITOR = "vi-host";
    try {
      const sb = createSandbox({
        config: { mode: "ephemeral" },
        manager: { maxConcurrentSandboxes: 4, skipSignalHooks: true },
      });
      // mode="none" strips host PATH entirely, so node-pty can't find "bash"
      // by name lookup. Use the absolute path. (This is the documented
      // behavior — tests/users running mode=none need to provide absolute
      // commands or seed sandbox bins themselves.)
      const session = await startSession({
        command: "/bin/bash",
        sandbox: sb,
        envInheritance: { mode: "none" },
      });
      try {
        await session.waitForRegex(/\$\s/, { timeoutMs: 3_000 });
        session.write('echo EDITOR_IS=[$EDITOR]\n');
        await session.waitForRegex(/EDITOR_IS=\[\]/, { timeoutMs: 3_000 });

        // PATH should be exactly the three sandbox bin dirs (no host PATH).
        // Long sandbox paths can wrap across terminal lines, so dump PATH to
        // a file and read it back via getCleanHistory rather than regex.
        session.write('echo "PATH_DUMP_START"; echo "$PATH"; echo "PATH_DUMP_END"\n');
        await session.waitForRegex(/PATH_DUMP_END/, { timeoutMs: 3_000 });
        // Pull the line between the markers from raw history.
        const clean = session.getCleanHistory().replace(/\r\n/g, "\n");
        const m = /PATH_DUMP_START\s*\n([\s\S]*?)\nPATH_DUMP_END/.exec(clean);
        expect(m).not.toBeNull();
        // Strip terminal-induced soft-wrap (no newlines mid-PATH expected,
        // but xterm may insert \r in long lines that survives the strip).
        const pathLine = m![1]!.replace(/[\r\n]+/g, "").trim();
        expect(pathLine).toBe(`${sb.path}/bin:${sb.path}/.local/bin:${sb.path}/.aikey/bin`);
      } finally {
        await session.close();
      }
    } finally {
      restoreEnv(prev);
    }
  }, TIMEOUT);

  it("caller env override: callerEnv overlays last, ANTHROPIC_API_KEY allowed by default", async () => {
    const sb = createSandbox({
      config: { mode: "ephemeral" },
      manager: { maxConcurrentSandboxes: 4, skipSignalHooks: true },
    });
    const session = await startSession({
      command: "bash",
      sandbox: sb,
      env: { ANTHROPIC_API_KEY: "sk-ant-caller", MY_PUBLIC: "public-x" },
    });
    try {
      await session.waitForRegex(/\$\s/, { timeoutMs: 3_000 });
      session.write('echo CK=[$ANTHROPIC_API_KEY] MP=[$MY_PUBLIC]\n');
      await session.waitForRegex(/CK=\[sk-ant-caller\]/, { timeoutMs: 3_000 });
      await session.waitForRegex(/MP=\[public-x\]/, { timeoutMs: 3_000 });
    } finally {
      await session.close();
    }
  }, TIMEOUT);
});

function restoreEnv(prev: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(prev)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}
