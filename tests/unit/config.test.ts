import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfig, DEFAULT_CONFIG } from "../../src/core/config.js";
import { ErrorCode, isTestableTerminalError } from "../../src/core/errors.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ttm-config-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("loadConfig — layer 1 (defaults only)", () => {
  it("with no file/env/overrides returns DEFAULT_CONFIG", () => {
    const cfg = loadConfig({ userConfigPath: null, workspaceConfigPath: null, env: {} });
    expect(cfg).toEqual(DEFAULT_CONFIG);
  });

  it("DEFAULT_CONFIG has expected sandbox.envInheritance.mode = all_with_overlay (round 2)", () => {
    expect(DEFAULT_CONFIG.sandbox.envInheritance.mode).toBe("all_with_overlay");
  });

  it("DEFAULT_CONFIG.session.defaultDisplay = headless (round 3)", () => {
    expect(DEFAULT_CONFIG.session.defaultDisplay).toBe("headless");
  });

  it("DEFAULT_CONFIG.security.allowedCommands is empty array (default-deny)", () => {
    expect(DEFAULT_CONFIG.security.allowedCommands).toEqual([]);
  });
});

describe("loadConfig — layer 2 (user file)", () => {
  it("merges user file over defaults", () => {
    const userPath = path.join(tmpDir, "config.json");
    fs.writeFileSync(userPath, JSON.stringify({
      session: { defaultRows: 50 },
      security: { allowedCommands: ["bash", "zsh"] },
    }));
    const cfg = loadConfig({ userConfigPath: userPath, workspaceConfigPath: null, env: {} });
    expect(cfg.session.defaultRows).toBe(50);
    expect(cfg.session.defaultCols).toBe(120); // default preserved
    expect(cfg.security.allowedCommands).toEqual(["bash", "zsh"]);
  });

  it("invalid JSON throws E_TT_CONFIG_INVALID", () => {
    const userPath = path.join(tmpDir, "config.json");
    fs.writeFileSync(userPath, "{ this is not valid json }");
    try {
      loadConfig({ userConfigPath: userPath, workspaceConfigPath: null, env: {} });
      expect.fail("should have thrown");
    } catch (err) {
      expect(isTestableTerminalError(err)).toBe(true);
      if (isTestableTerminalError(err)) expect(err.code).toBe(ErrorCode.CONFIG_INVALID);
    }
  });

  it("non-object root throws E_TT_CONFIG_INVALID", () => {
    const userPath = path.join(tmpDir, "config.json");
    fs.writeFileSync(userPath, JSON.stringify(["array", "not", "object"]));
    expect(() => loadConfig({ userConfigPath: userPath, workspaceConfigPath: null, env: {} })).toThrow(/CONFIG_INVALID|object at top level/);
  });

  it("non-existent path is silently ignored (file optional)", () => {
    const cfg = loadConfig({
      userConfigPath: path.join(tmpDir, "nope.json"),
      workspaceConfigPath: null,
      env: {},
    });
    expect(cfg).toEqual(DEFAULT_CONFIG);
  });
});

describe("loadConfig — layer 3 (workspace file via $TESTABLE_TERMINAL_CONFIG)", () => {
  it("workspace overrides user", () => {
    const userPath = path.join(tmpDir, "user.json");
    const wsPath = path.join(tmpDir, "ws.json");
    fs.writeFileSync(userPath, JSON.stringify({ session: { defaultRows: 50 } }));
    fs.writeFileSync(wsPath, JSON.stringify({ session: { defaultRows: 80 } }));
    const cfg = loadConfig({ userConfigPath: userPath, workspaceConfigPath: wsPath, env: {} });
    expect(cfg.session.defaultRows).toBe(80);
  });

  it("env $TESTABLE_TERMINAL_CONFIG resolves to file", () => {
    const wsPath = path.join(tmpDir, "ws.json");
    fs.writeFileSync(wsPath, JSON.stringify({ session: { defaultCols: 200 } }));
    const cfg = loadConfig({
      userConfigPath: null,
      // explicitly leave workspaceConfigPath undefined → reads env
      env: { TESTABLE_TERMINAL_CONFIG: wsPath },
    });
    expect(cfg.session.defaultCols).toBe(200);
  });
});

describe("loadConfig — layer 4 (TT_* env vars)", () => {
  it("TT_DEFAULT_ROWS overrides session.defaultRows", () => {
    const cfg = loadConfig({
      userConfigPath: null, workspaceConfigPath: null,
      env: { TT_DEFAULT_ROWS: "60" },
    });
    expect(cfg.session.defaultRows).toBe(60);
  });

  it("TT_AIKEY_MAKEFILE_DIR sets aikey.makefileDir", () => {
    const cfg = loadConfig({
      userConfigPath: null, workspaceConfigPath: null,
      env: { TT_AIKEY_MAKEFILE_DIR: "/path/to/aikeylabs/workflow/CI" },
    });
    expect(cfg.aikey.makefileDir).toBe("/path/to/aikeylabs/workflow/CI");
  });

  it("env beats file beats default — full chain", () => {
    const userPath = path.join(tmpDir, "user.json");
    fs.writeFileSync(userPath, JSON.stringify({ session: { defaultRows: 50 } }));
    const cfg = loadConfig({
      userConfigPath: userPath, workspaceConfigPath: null,
      env: { TT_DEFAULT_ROWS: "70" },
    });
    expect(cfg.session.defaultRows).toBe(70);
  });
});

describe("loadConfig — overrides (per-call)", () => {
  it("explicit overrides are highest priority", () => {
    const cfg = loadConfig({
      userConfigPath: null, workspaceConfigPath: null,
      env: { TT_DEFAULT_ROWS: "60" },
      overrides: { session: { defaultRows: 99 } as never } as never,
    });
    expect(cfg.session.defaultRows).toBe(99);
  });
});

describe("loadConfig — schema validation", () => {
  it("rejects negative maxConcurrentSessions", () => {
    const userPath = path.join(tmpDir, "user.json");
    fs.writeFileSync(userPath, JSON.stringify({ security: { maxConcurrentSessions: -5 } }));
    expect(() => loadConfig({ userConfigPath: userPath, workspaceConfigPath: null, env: {} }))
      .toThrow(/CONFIG_INVALID|maxConcurrentSessions/);
  });

  it("rejects unknown envInheritance.mode", () => {
    const userPath = path.join(tmpDir, "user.json");
    fs.writeFileSync(userPath, JSON.stringify({ sandbox: { envInheritance: { mode: "wide-open" } } }));
    try {
      loadConfig({ userConfigPath: userPath, workspaceConfigPath: null, env: {} });
      expect.fail("should have thrown");
    } catch (err) {
      expect(isTestableTerminalError(err)).toBe(true);
      if (isTestableTerminalError(err)) {
        expect(err.code).toBe(ErrorCode.CONFIG_INVALID);
        expect(err.message).toMatch(/envInheritance\.mode|wide-open/);
      }
    }
  });
});
