import { describe, it, expect } from "vitest";
import { newSessionId, newShortId } from "../../src/utils/id.js";

describe("newSessionId", () => {
  it("starts with default prefix", () => {
    expect(newSessionId()).toMatch(/^term_/);
  });

  it("respects custom prefix", () => {
    expect(newSessionId("sbx_")).toMatch(/^sbx_/);
    expect(newSessionId("")).not.toMatch(/^[a-z]+_/);
  });

  it("has 26 char body (10 ts + 16 random) after prefix", () => {
    const id = newSessionId("term_");
    expect(id.slice("term_".length)).toHaveLength(26);
  });

  it("uses Crockford alphabet only (no I, L, O, U)", () => {
    const id = newSessionId("");
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]+$/);
  });

  it("ids are unique across many calls", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const id = newSessionId();
      expect(seen.has(id), `duplicate id ${id}`).toBe(false);
      seen.add(id);
    }
  });

  it("timestamp prefix is monotonic for monotonic clock", () => {
    let t = 1700_000_000_000;
    const clock = () => t++;
    const ids = Array.from({ length: 100 }, () => newSessionId("t_", clock));
    const sorted = [...ids].sort();
    expect(sorted).toEqual(ids);
  });
});

describe("newShortId", () => {
  it("16-char body (8 ts + 8 random)", () => {
    expect(newShortId("")).toHaveLength(16);
  });

  it("respects prefix", () => {
    expect(newShortId("snap_")).toMatch(/^snap_/);
  });
});
