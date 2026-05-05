import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { readScreen, snapshotHash } from "../../src/core/snapshot.js";

// @xterm/headless is CJS; load via createRequire to avoid ESM named-export issues.
const require = createRequire(import.meta.url);
const xtermHeadless = require("@xterm/headless") as typeof import("@xterm/headless");
const { Terminal } = xtermHeadless;
type TerminalCls = InstanceType<typeof Terminal>;

/** Drain xterm parser by waiting for the write callback. */
async function termWrite(term: TerminalCls, data: string): Promise<void> {
  return new Promise<void>((resolve) => term.write(data, () => resolve()));
}

function makeTerm(rows = 8, cols = 40): TerminalCls {
  return new Terminal({ rows, cols, allowProposedApi: true });
}

describe("snapshotHash", () => {
  it("is stable for the same input", () => {
    expect(snapshotHash("hello world")).toBe(snapshotHash("hello world"));
  });
  it("differs across inputs", () => {
    expect(snapshotHash("a")).not.toBe(snapshotHash("b"));
  });
  it("returns 12-char hex", () => {
    expect(snapshotHash("anything")).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe("readScreen — default range (lastLines: 200)", () => {
  it("captures plain text from a basic write", async () => {
    const term = makeTerm();
    await termWrite(term, "hello\r\nworld\r\n");
    const r = readScreen(term);
    expect(r.plainText).toContain("hello");
    expect(r.plainText).toContain("world");
  });

  it("trims trailing empty lines", async () => {
    const term = makeTerm(8);
    await termWrite(term, "only one line\r\n");
    const r = readScreen(term);
    expect(r.plainLines.length).toBeLessThan(8); // empty rows trimmed
    expect(r.plainLines[r.plainLines.length - 1]!.trim()).not.toBe("");
  });

  it("preserves ANSI in ansiText (e.g. SGR colors)", async () => {
    const term = makeTerm();
    // \x1b[31mRED\x1b[0m PLAIN
    await termWrite(term, "\x1b[31mRED\x1b[0m PLAIN\r\n");
    const r = readScreen(term);
    expect(r.plainText).toContain("RED");
    expect(r.plainText).toContain("PLAIN");
    // The ANSI version should contain SGR escape sequences.
    expect(r.ansiText).toMatch(/\x1b\[/);
  });
});

describe("readScreen — range='viewport'", () => {
  it("returns at most rows lines (viewport-bounded)", async () => {
    const term = makeTerm(4, 40);
    // Pump 10 lines — most will scroll out of viewport into scrollback.
    await termWrite(term, Array.from({ length: 10 }, (_, i) => `line-${i + 1}`).join("\r\n") + "\r\n");
    const r = readScreen(term, "viewport");
    expect(r.range.kind).toBe("viewport");
    // After trim of trailing empties, we expect at most 4 rows.
    expect(r.plainLines.length).toBeLessThanOrEqual(4);
    // Last visible line should be the most recent.
    expect(r.plainText).toContain("line-10");
    // Earliest lines should NOT be in viewport.
    expect(r.plainText).not.toContain("line-1\n");
  });
});

describe("readScreen — range={ lastLines: N }", () => {
  it("returns last N rows from buffer end", async () => {
    const term = makeTerm(4, 40);
    await termWrite(term, Array.from({ length: 30 }, (_, i) => `line-${i + 1}`).join("\r\n") + "\r\n");
    const r = readScreen(term, { lastLines: 5 });
    expect(r.range.kind).toBe("lastLines");
    // Last 5 lines should include line-30 etc.
    expect(r.plainText).toContain("line-30");
    expect(r.plainText).toContain("line-29");
    // Old lines beyond lastLines should NOT be present.
    expect(r.plainText).not.toContain("line-1\n");
  });

  it("clamps to total buffer rows when N > buffer", async () => {
    const term = makeTerm(4, 40);
    await termWrite(term, "only one line\r\n");
    const r = readScreen(term, { lastLines: 1000 });
    expect(r.plainText).toContain("only one line");
  });
});

describe("readScreen — range='all'", () => {
  it("includes scrollback (lines that scrolled out of viewport)", async () => {
    const term = makeTerm(4, 40);
    await termWrite(term, Array.from({ length: 20 }, (_, i) => `s-${i + 1}`).join("\r\n") + "\r\n");
    const all = readScreen(term, "all");
    expect(all.range.kind).toBe("all");
    expect(all.plainText).toContain("s-1");
    expect(all.plainText).toContain("s-20");
  });
});

describe("readScreen — paired plain/ansi line counts always match", () => {
  it("plainLines.length === ansiLines.length", async () => {
    const term = makeTerm();
    await termWrite(term, "\x1b[32mone\x1b[0m\r\n\x1b[33mtwo\x1b[0m\r\n");
    const r = readScreen(term);
    expect(r.plainLines.length).toBe(r.ansiLines.length);
  });
});

describe("readScreen — range diagnostics", () => {
  it("range.startRow and endRow are within bounds", async () => {
    const term = makeTerm(4);
    await termWrite(term, "x\r\n");
    const r = readScreen(term, "all");
    expect(r.range.startRow).toBe(0);
    expect(r.range.endRow).toBe(r.range.totalBufferRows);
  });
});
