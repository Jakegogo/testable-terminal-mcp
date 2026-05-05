import { describe, it, expect } from "vitest";
import { wrapWithLoginShell, shellQuotePosix, shellQuotePwsh } from "../../src/core/shell-wrap.js";
import { inferPlatform } from "../../src/core/platform.js";

const POSIX = inferPlatform("darwin", "arm64");
const WINDOWS = inferPlatform("win32", "x64");

describe("wrapWithLoginShell — disabled (loginShell=false)", () => {
  it("passes through command + args verbatim", () => {
    const r = wrapWithLoginShell({
      command: "claude", args: ["--no-banner"], loginShell: false, platform: POSIX,
    });
    expect(r.command).toBe("claude");
    expect(r.args).toEqual(["--no-banner"]);
    expect(r.description).toMatch(/^direct:/);
  });
});

describe("wrapWithLoginShell — POSIX", () => {
  it("wraps non-shell command in $SHELL -ilc 'exec ...'", () => {
    const r = wrapWithLoginShell({
      command: "claude", args: [], loginShell: true, shellPath: "/bin/zsh", platform: POSIX,
    });
    expect(r.command).toBe("/bin/zsh");
    expect(r.args).toEqual(["-ilc", "exec claude"]);
  });

  it("preserves args (quoted properly)", () => {
    const r = wrapWithLoginShell({
      command: "claude", args: ["--prompt", "hello world"], loginShell: true,
      shellPath: "/bin/zsh", platform: POSIX,
    });
    expect(r.args[0]).toBe("-ilc");
    expect(r.args[1]).toContain("'hello world'");
  });

  it("special-cases when command IS a shell — adds -il flag, no nesting", () => {
    const r = wrapWithLoginShell({
      command: "bash", args: [], loginShell: true, platform: POSIX,
    });
    expect(r.command).toBe("bash");
    expect(r.args).toEqual(["-il"]);
    expect(r.description).toContain("shell-with-rc");
  });

  it("recognizes shell by basename even with absolute path", () => {
    const r = wrapWithLoginShell({
      command: "/usr/local/bin/zsh", args: [], loginShell: true, platform: POSIX,
    });
    expect(r.args).toEqual(["-il"]);
  });
});

describe("wrapWithLoginShell — Windows", () => {
  it("wraps non-shell command via pwsh -NoLogo -Command '& ...'", () => {
    const r = wrapWithLoginShell({
      command: "claude", args: [], loginShell: true, platform: WINDOWS,
    });
    expect(r.command).toBe("pwsh");
    expect(r.args[0]).toBe("-NoLogo");
    expect(r.args[1]).toBe("-Command");
    expect(r.args[2]).toMatch(/^& claude/);
  });

  it("special-cases when command IS pwsh — passes -NoLogo + caller args", () => {
    const r = wrapWithLoginShell({
      command: "pwsh.exe", args: ["-File", "x.ps1"], loginShell: true, platform: WINDOWS,
    });
    expect(r.command).toBe("pwsh.exe");
    expect(r.args).toEqual(["-NoLogo", "-File", "x.ps1"]);
  });
});

describe("shellQuotePosix", () => {
  it.each([
    ["", "''"],
    ["safe", "safe"],
    ["safe.with.dots", "safe.with.dots"],
    ["needs space", "'needs space'"],
    ["it's a quote", "'it'\\''s a quote'"],
    ["multi'quote'tokens", "'multi'\\''quote'\\''tokens'"],
  ])("posix(%s) = %s", (input, expected) => {
    expect(shellQuotePosix(input)).toBe(expected);
  });
});

describe("shellQuotePwsh", () => {
  it.each([
    ["", "''"],
    ["safe", "safe"],
    ["needs space", "'needs space'"],
    ["it's a quote", "'it''s a quote'"],
  ])("pwsh(%s) = %s", (input, expected) => {
    expect(shellQuotePwsh(input)).toBe(expected);
  });
});

describe("wrapWithLoginShell — preSourceFiles (POSIX)", () => {
  it("prepends `[ -f f ] && . f 2>/dev/null;` for each file before exec", () => {
    const prevHome = process.env.HOME;
    process.env.HOME = "/Users/test";
    try {
      const r = wrapWithLoginShell({
        command: "codex",
        args: ["exec", "5+10=?"],
        loginShell: true,
        shellPath: "/bin/zsh",
        platform: POSIX,
        preSourceFiles: ["~/.aikey/active.env", "/etc/extra.env"],
      });
      expect(r.command).toBe("/bin/zsh");
      expect(r.args[0]).toBe("-ilc");
      const cmd = r.args[1]!;
      // Tilde expanded against $HOME
      expect(cmd).toContain("[ -f /Users/test/.aikey/active.env ] && . /Users/test/.aikey/active.env 2>/dev/null");
      // Absolute path passed through
      expect(cmd).toContain("[ -f /etc/extra.env ] && . /etc/extra.env 2>/dev/null");
      // exec follows the source chain
      expect(cmd).toMatch(/2>\/dev\/null;\s*exec codex exec '5\+10=\?'/);
    } finally {
      if (prevHome !== undefined) process.env.HOME = prevHome;
    }
  });

  it("no preSourceFiles → no source prefix", () => {
    const r = wrapWithLoginShell({
      command: "claude", args: [], loginShell: true,
      shellPath: "/bin/zsh", platform: POSIX,
    });
    expect(r.args[1]).toBe("exec claude");
  });

  it("empty preSourceFiles array → no source prefix", () => {
    const r = wrapWithLoginShell({
      command: "claude", args: [], loginShell: true,
      shellPath: "/bin/zsh", platform: POSIX,
      preSourceFiles: [],
    });
    expect(r.args[1]).toBe("exec claude");
  });
});

describe("wrapWithLoginShell — preSourceFiles (Windows)", () => {
  it("uses `if (Test-Path) { . file }` for pwsh dot-source", () => {
    const prevHome = process.env.HOME;
    process.env.HOME = "C:/Users/test";
    try {
      const r = wrapWithLoginShell({
        command: "claude.exe",
        args: ["--print", "x"],
        loginShell: true,
        shellPath: "pwsh",
        platform: WINDOWS,
        preSourceFiles: ["~/.aikey/active.ps1"],
      });
      expect(r.command).toBe("pwsh");
      const cmd = r.args[2]!;
      // The path is "safe" per shellQuotePwsh (alphanumeric + : / . - _),
      // so no quoting added — pwsh accepts unquoted safe paths.
      expect(cmd).toContain("if (Test-Path C:/Users/test/.aikey/active.ps1) { . C:/Users/test/.aikey/active.ps1 }");
      expect(cmd).toContain("& claude.exe --print x");
    } finally {
      if (prevHome !== undefined) process.env.HOME = prevHome;
    }
  });
});

describe("wrapWithLoginShell — simulatePrecmdHooks (POSIX)", () => {
  it("zsh: emits `for f in precmd_functions; do f; done` before exec", () => {
    const r = wrapWithLoginShell({
      command: "codex", args: ["exec", "x"], loginShell: true,
      shellPath: "/bin/zsh", platform: POSIX, simulatePrecmdHooks: true,
    });
    expect(r.command).toBe("/bin/zsh");
    const cmd = r.args[1]!;
    expect(cmd).toContain("precmd_functions");
    expect(cmd).toMatch(/for __ttm_precmd_fn in.*precmd_functions/);
    expect(cmd).toContain("\"$__ttm_precmd_fn\" 2>/dev/null");
    expect(cmd).toContain("unset __ttm_precmd_fn");
    expect(cmd).toContain("exec codex exec x");
    // Order: trigger BEFORE exec
    const triggerIdx = cmd.indexOf("precmd_functions");
    const execIdx = cmd.indexOf("exec codex");
    expect(triggerIdx).toBeLessThan(execIdx);
  });

  it("bash: emits `eval $PROMPT_COMMAND` before exec", () => {
    const r = wrapWithLoginShell({
      command: "claude", args: [], loginShell: true,
      shellPath: "/bin/bash", platform: POSIX, simulatePrecmdHooks: true,
    });
    const cmd = r.args[1]!;
    expect(cmd).toContain("PROMPT_COMMAND");
    expect(cmd).toContain('eval "${PROMPT_COMMAND}" 2>/dev/null');
    expect(cmd).toContain("exec claude");
  });

  it("unknown shell (e.g. /usr/bin/fish): no-op (empty trigger prefix)", () => {
    const r = wrapWithLoginShell({
      command: "claude", args: [], loginShell: true,
      shellPath: "/usr/bin/fish", platform: POSIX, simulatePrecmdHooks: true,
    });
    const cmd = r.args[1]!;
    expect(cmd).not.toContain("precmd_functions");
    expect(cmd).not.toContain("PROMPT_COMMAND");
    expect(cmd).toBe("exec claude");
  });

  it("simulatePrecmdHooks=false: no trigger emitted", () => {
    const r = wrapWithLoginShell({
      command: "codex", args: [], loginShell: true,
      shellPath: "/bin/zsh", platform: POSIX, simulatePrecmdHooks: false,
    });
    expect(r.args[1]).toBe("exec codex");
  });

  it("preSourceFiles + simulatePrecmdHooks: source first, trigger after, then exec", () => {
    const prevHome = process.env.HOME;
    process.env.HOME = "/Users/test";
    try {
      const r = wrapWithLoginShell({
        command: "codex", args: [], loginShell: true,
        shellPath: "/bin/zsh", platform: POSIX,
        preSourceFiles: ["~/.aikey/active.env"],
        simulatePrecmdHooks: true,
      });
      const cmd = r.args[1]!;
      const sourceIdx = cmd.indexOf("/Users/test/.aikey/active.env");
      const triggerIdx = cmd.indexOf("precmd_functions");
      const execIdx = cmd.indexOf("exec codex");
      expect(sourceIdx).toBeLessThan(triggerIdx);
      expect(triggerIdx).toBeLessThan(execIdx);
    } finally {
      if (prevHome !== undefined) process.env.HOME = prevHome;
    }
  });

  it("zsh basename detection robust to /usr/local/bin/zsh path", () => {
    const r = wrapWithLoginShell({
      command: "codex", args: [], loginShell: true,
      shellPath: "/usr/local/bin/zsh", platform: POSIX, simulatePrecmdHooks: true,
    });
    expect(r.args[1]).toContain("precmd_functions");
  });
});
