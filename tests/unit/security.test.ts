import { describe, it, expect } from "vitest";
import {
  assertAllowedCommand,
  assertAllowedCwd,
  shouldRedact,
  redactEnv,
  filterCallerEnv,
} from "../../src/core/security.js";
import { ErrorCode, isTestableTerminalError } from "../../src/core/errors.js";

describe("assertAllowedCommand", () => {
  it("default empty list rejects everything", () => {
    expect(() => assertAllowedCommand("bash", { allowedCommands: [] })).toThrow();
  });

  it("matches by basename, ignores path prefix", () => {
    expect(() => assertAllowedCommand("/usr/local/bin/bash", { allowedCommands: ["bash"] })).not.toThrow();
    expect(() => assertAllowedCommand("/opt/sneaky/bash", { allowedCommands: ["bash"] })).not.toThrow();
  });

  it("strips Windows .exe / .cmd / .ps1 / .bat suffix", () => {
    expect(() => assertAllowedCommand("pwsh.exe", { allowedCommands: ["pwsh"] })).not.toThrow();
    expect(() => assertAllowedCommand("script.cmd", { allowedCommands: ["script"] })).not.toThrow();
  });

  it("explicit ['*'] wildcard allows anything", () => {
    expect(() => assertAllowedCommand("rm", { allowedCommands: ["*"] })).not.toThrow();
    expect(() => assertAllowedCommand("/usr/bin/anything", { allowedCommands: ["*"] })).not.toThrow();
  });

  it("rejected command throws E_TT_CMD_NOT_ALLOWED with hint", () => {
    try {
      assertAllowedCommand("rm", { allowedCommands: ["bash", "claude"] });
      expect.fail("should have thrown");
    } catch (err) {
      expect(isTestableTerminalError(err)).toBe(true);
      if (isTestableTerminalError(err)) {
        expect(err.code).toBe(ErrorCode.CMD_NOT_ALLOWED);
        expect(err.details.hint).toContain("rm");
      }
    }
  });
});

describe("assertAllowedCwd", () => {
  it("exact match passes", () => {
    expect(() => assertAllowedCwd("/tmp", { allowedWorkdirs: ["/tmp"] })).not.toThrow();
  });

  it("subdirectory of allowed passes", () => {
    expect(() => assertAllowedCwd("/tmp/foo/bar", { allowedWorkdirs: ["/tmp"] })).not.toThrow();
  });

  it("sibling of allowed throws", () => {
    try {
      assertAllowedCwd("/var", { allowedWorkdirs: ["/tmp"] });
      expect.fail("should have thrown");
    } catch (err) {
      expect(isTestableTerminalError(err)).toBe(true);
      if (isTestableTerminalError(err)) expect(err.code).toBe(ErrorCode.CWD_NOT_ALLOWED);
    }
  });

  it("../ traversal can't escape allowed root", () => {
    // /tmp/../etc resolves to /etc — outside /tmp
    expect(() => assertAllowedCwd("/tmp/../etc", { allowedWorkdirs: ["/tmp"] })).toThrow();
  });

  it("prefix-collision doesn't false-pass (e.g. /tmpa is not under /tmp)", () => {
    expect(() => assertAllowedCwd("/tmpa", { allowedWorkdirs: ["/tmp"] })).toThrow();
  });
});

describe("shouldRedact / redactEnv", () => {
  const patterns = ["*KEY*", "*TOKEN*", "AIKEY_*", "ANTHROPIC_API_KEY"];

  it.each([
    ["ANTHROPIC_API_KEY", true],
    ["OPENAI_API_KEY", true],         // matches *KEY*
    ["MY_TOKEN_FOR_X", true],         // matches *TOKEN*
    ["AIKEY_PROXY_PORT", true],       // matches AIKEY_*
    ["PATH", false],
    ["HOME", false],
    ["TERM", false],
    ["", false],
  ])("shouldRedact(%s) = %s", (key, expected) => {
    expect(shouldRedact(key, patterns)).toBe(expected);
  });

  it("case-insensitive", () => {
    expect(shouldRedact("anthropic_api_key", patterns)).toBe(true);
  });

  it("redactEnv replaces values", () => {
    const env = { PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-real", HOME: "/home/u" };
    const out = redactEnv(env, patterns);
    expect(out.PATH).toBe("/usr/bin");
    expect(out.HOME).toBe("/home/u");
    expect(out.ANTHROPIC_API_KEY).toBe("***REDACTED***");
  });

  it("empty patterns = no-op", () => {
    expect(shouldRedact("ANYTHING", [])).toBe(false);
  });
});

describe("filterCallerEnv (round 7 two-layer model)", () => {
  const denyKeys = ["ANTHROPIC_API_KEY", "AIKEY_*"];

  it("allowCallerSecretEnv=true: caller can pass anything", () => {
    const out = filterCallerEnv(
      { ANTHROPIC_API_KEY: "real", FOO: "bar" },
      { allowCallerSecretEnv: true, strictDeny: false, denyKeys },
    );
    expect(out).toEqual({ ANTHROPIC_API_KEY: "real", FOO: "bar" });
  });

  it("allowCallerSecretEnv=false + strictDeny=true: throws on offending key", () => {
    expect(() =>
      filterCallerEnv(
        { ANTHROPIC_API_KEY: "real", FOO: "bar" },
        { allowCallerSecretEnv: false, strictDeny: true, denyKeys },
      ),
    ).toThrow(/ENV_KEY_NOT_ALLOWED|ANTHROPIC_API_KEY/);
  });

  it("allowCallerSecretEnv=false + strictDeny=false: silently drops offending key", () => {
    const out = filterCallerEnv(
      { ANTHROPIC_API_KEY: "real", FOO: "bar", AIKEY_PORT: "27200" },
      { allowCallerSecretEnv: false, strictDeny: false, denyKeys },
    );
    expect(out).toEqual({ FOO: "bar" });
  });
});
