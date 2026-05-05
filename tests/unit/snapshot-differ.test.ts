/**
 * Unit tests for the snapshot differ — masks, normalization, unified diff.
 */

import { describe, it, expect } from "vitest";
import {
  applyMasks, normalize, diffSnapshots, unifiedDiff,
} from "../../src/core/snapshot-test/differ.js";
import { resolveMasks, PRESETS, presetNames } from "../../src/core/snapshot-test/masks.js";

describe("applyMasks", () => {
  it("applies pattern → replace using regex with flags default 'g'", () => {
    const r = applyMasks("a=1, a=2, a=3", [{ pattern: "a=\\d", replace: "a=<X>" }]);
    expect(r).toBe("a=<X>, a=<X>, a=<X>");
  });

  it("masks apply in array order; later masks see earlier replacements", () => {
    const r = applyMasks("foo bar baz", [
      { pattern: "bar", replace: "BAR" },
      { pattern: "BAR", replace: "qux" },
    ]);
    expect(r).toBe("foo qux baz");
  });

  it("custom flags option respected", () => {
    const r = applyMasks("HELLO hello HELLO", [{ pattern: "hello", replace: "x", flags: "gi" }]);
    expect(r).toBe("x x x");
  });
});

describe("normalize", () => {
  it("collapses CRLF to LF", () => {
    expect(normalize("a\r\nb\r\nc")).toBe("a\nb\nc");
  });

  it("strips trailing whitespace per line", () => {
    expect(normalize("hello   \nworld\t\n")).toBe("hello\nworld");
  });

  it("drops trailing blank lines", () => {
    expect(normalize("a\nb\n\n\n\n")).toBe("a\nb");
  });

  it("preserves internal blank lines", () => {
    expect(normalize("a\n\nb")).toBe("a\n\nb");
  });
});

describe("diffSnapshots", () => {
  it("matched=true when texts equal post-mask + post-normalize", () => {
    const r = diffSnapshots({
      expected: "claude pid=123\n",
      actual:   "claude pid=999\n",
      masks: [{ pattern: "pid=\\d+", replace: "pid=<MASKED>" }],
    });
    expect(r.matched).toBe(true);
    expect(r.diff).toBe("");
  });

  it("returns unified diff on mismatch", () => {
    const r = diffSnapshots({
      expected: "line1\nline2\nline3\n",
      actual:   "line1\nLINE2\nline3\n",
      masks: [],
    });
    expect(r.matched).toBe(false);
    expect(r.diff).toContain("-line2");
    expect(r.diff).toContain("+LINE2");
  });

  it("Windows CRLF normalized → equals POSIX LF input", () => {
    const r = diffSnapshots({
      expected: "a\nb\nc",
      actual:   "a\r\nb\r\nc\r\n",
      masks: [],
    });
    expect(r.matched).toBe(true);
  });
});

describe("unifiedDiff format", () => {
  it("includes --- expected / +++ actual headers", () => {
    const d = unifiedDiff("a", "b");
    expect(d).toContain("--- expected");
    expect(d).toContain("+++ actual");
  });

  it("hunks include line-numbered @@ markers", () => {
    const d = unifiedDiff("a\nb\nc\nd\ne", "a\nb\nX\nd\ne");
    expect(d).toMatch(/@@ -\d+,\d+ \+\d+,\d+ @@/);
  });

  it("returns '' for identical inputs", () => {
    expect(unifiedDiff("same\nsame", "same\nsame")).toBe("");
  });
});

describe("masks presets", () => {
  it("has 4 presets (claude-tui, kimi-tui, aikey-cli, common-time)", () => {
    expect(presetNames().sort()).toEqual(["aikey-cli", "claude-tui", "common-time", "kimi-tui"]);
  });

  it("claude-tui masks Crunched / Claude Code v / pid", () => {
    const t = "Crunched for 12s — Claude Code v1.2.3 — pid=4567";
    const masked = applyMasks(t, PRESETS["claude-tui"]!);
    expect(masked).toContain("Crunched for <MASKED>s");
    expect(masked).toContain("Claude Code v<MASKED>");
    expect(masked).toContain("pid=<MASKED>");
  });

  it("common-time masks ISO timestamps + UUIDs", () => {
    const t = "ts=2026-05-04T10:00:00Z uuid=abcdef12-3456-7890-abcd-ef1234567890";
    const masked = applyMasks(t, PRESETS["common-time"]!);
    expect(masked).toContain("<TIMESTAMP>");
    expect(masked).toContain("<UUID>");
  });

  it("resolveMasks composes presets + inline; unknown preset throws", () => {
    const r = resolveMasks(["common-time"], [{ pattern: "Foo", replace: "Bar" }]);
    expect(r.length).toBeGreaterThan(1);
    expect(r[r.length - 1]).toEqual({ pattern: "Foo", replace: "Bar" });
    expect(() => resolveMasks(["nonexistent-preset"])).toThrow(/unknown mask preset/);
  });
});
