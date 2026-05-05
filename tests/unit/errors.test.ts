import { describe, it, expect } from "vitest";
import { ErrorCode, TestableTerminalError, isTestableTerminalError } from "../../src/core/errors.js";

describe("ErrorCode enum", () => {
  it("every code has E_TT_ prefix", () => {
    for (const v of Object.values(ErrorCode)) {
      expect(v).toMatch(/^E_TT_/);
    }
  });

  it("naming convention: each code matches one of the documented suffixes", () => {
    const allowed = /_(FAILED|TIMEOUT|NOT_ALLOWED|NOT_FOUND|LIMIT|INVALID|INPUT|CRASHED|CORRUPT|MISMATCH|MISSING|PENDING|DUPLICATES|DIFF|CHANGED|LEAK|DEAD)$/;
    // Codes that don't fit the suffixes (legacy / business-flow names) — keep an explicit allowlist:
    const exceptions = new Set<string>([
      "E_TT_ASSERT_NOT_IDEMPOTENT", // descriptive (negation of IDEMPOTENT)
    ]);
    for (const v of Object.values(ErrorCode)) {
      if (allowed.test(v) || exceptions.has(v)) continue;
      throw new Error(`error code ${v} doesn't follow naming convention; add to exceptions if intentional`);
    }
  });

  it("no duplicate values", () => {
    const seen = new Set<string>();
    for (const v of Object.values(ErrorCode)) {
      expect(seen.has(v), `duplicate code ${v}`).toBe(false);
      seen.add(v);
    }
  });
});

describe("TestableTerminalError", () => {
  it("carries code, message, details", () => {
    const err = new TestableTerminalError(ErrorCode.EXPECT_TIMEOUT, "timeout 5s", { hint: "raise timeout" });
    expect(err.code).toBe("E_TT_EXPECT_TIMEOUT");
    expect(err.message).toBe("timeout 5s");
    expect(err.details.hint).toBe("raise timeout");
  });

  it("toJSON strips snapshot from details (default)", () => {
    const err = new TestableTerminalError(ErrorCode.EXPECT_TIMEOUT, "x", { snapshot: { plain: "huge" }, hint: "h" });
    const j = err.toJSON();
    expect(j.ok).toBe(false);
    expect(j.error_code).toBe("E_TT_EXPECT_TIMEOUT");
    expect(j.hint).toBe("h");
    expect(j.details).not.toHaveProperty("snapshot");
  });

  it("toJSONWithSnapshot includes snapshot when caller wants it", () => {
    const err = new TestableTerminalError(ErrorCode.EXPECT_TIMEOUT, "x", { snapshot: { plain: "huge" } });
    const j = err.toJSONWithSnapshot();
    expect(j.snapshot).toEqual({ plain: "huge" });
  });

  it("isTestableTerminalError type guard", () => {
    const err = new TestableTerminalError(ErrorCode.INVALID_INPUT, "x");
    expect(isTestableTerminalError(err)).toBe(true);
    expect(isTestableTerminalError(new Error("plain"))).toBe(false);
    expect(isTestableTerminalError(null)).toBe(false);
    expect(isTestableTerminalError(undefined)).toBe(false);
    expect(isTestableTerminalError("string")).toBe(false);
  });

  it("preserves stack trace", () => {
    const err = new TestableTerminalError(ErrorCode.PTY_SPAWN_FAILED, "boom");
    expect(err.stack).toBeDefined();
    expect(err.stack).toContain("boom");
  });
});
