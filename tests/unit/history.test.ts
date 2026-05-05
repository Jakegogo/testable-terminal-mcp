import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionHistory, stripAnsi } from "../../src/core/session/history.js";

let tmpDir: string;
beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ttm-history-test-")); });
afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

describe("SessionHistory — in-memory only (no disk path)", () => {
  it("starts empty", () => {
    const h = new SessionHistory({ maxHistoryBytes: 1024, historyLogPath: null });
    expect(h.getHistoryStats()).toEqual({ bytes: 0, chunks: 0, truncated: false, path: null });
    expect(h.getRawHistory()).toBe("");
  });

  it("accumulates raw bytes across appends", () => {
    const h = new SessionHistory({ maxHistoryBytes: 1024, historyLogPath: null });
    h.append("hello ");
    h.append("world");
    const stats = h.getHistoryStats();
    expect(stats.bytes).toBe(11);
    expect(stats.chunks).toBe(2);
    expect(stats.truncated).toBe(false);
    expect(h.getRawHistory()).toBe("hello world");
  });

  it("preserves ANSI in raw history", () => {
    const h = new SessionHistory({ maxHistoryBytes: 1024, historyLogPath: null });
    h.append("\x1b[31mRED\x1b[0m PLAIN");
    expect(h.getRawHistory()).toContain("\x1b[31m");
    expect(h.getCleanHistory()).toBe("RED PLAIN");
  });

  it("getRawHistoryBytes returns Buffer", () => {
    const h = new SessionHistory({ maxHistoryBytes: 1024, historyLogPath: null });
    h.append("xyz");
    const b = h.getRawHistoryBytes();
    expect(Buffer.isBuffer(b)).toBe(true);
    expect(b.toString("utf8")).toBe("xyz");
  });
});

describe("SessionHistory — ring buffer FIFO truncation", () => {
  it("drops oldest chunks when over maxBytes, sets truncated=true", () => {
    const h = new SessionHistory({ maxHistoryBytes: 10, historyLogPath: null });
    h.append("aaaaa");   // 5 bytes
    h.append("bbbbb");   // 5 bytes — total 10 (at boundary)
    h.append("ccccc");   // overflow → drop "aaaaa"
    const stats = h.getHistoryStats();
    expect(stats.truncated).toBe(true);
    expect(stats.bytes).toBeLessThanOrEqual(10);
    expect(h.getRawHistory()).toBe("bbbbbccccc");
  });

  it("retains newest content even with tiny budget", () => {
    const h = new SessionHistory({ maxHistoryBytes: 8, historyLogPath: null });
    for (let i = 0; i < 10; i++) h.append(`L${i}_`);
    expect(h.getRawHistory()).toContain("L9_");
  });

  it("chunks counter still increments after truncation (it tracks events, not size)", () => {
    const h = new SessionHistory({ maxHistoryBytes: 4, historyLogPath: null });
    h.append("xxx");
    h.append("yyy");
    h.append("zzz");
    expect(h.getHistoryStats().chunks).toBe(3);
  });
});

describe("SessionHistory — disk mirror", () => {
  it("appends to historyLogPath as bytes arrive", async () => {
    const logPath = path.join(tmpDir, "h.log");
    const h = new SessionHistory({ maxHistoryBytes: 1024, historyLogPath: logPath });
    h.append("part1\n");
    h.append("part2\n");
    await h.endDiskStream();
    const onDisk = fs.readFileSync(logPath, "utf8");
    expect(onDisk).toBe("part1\npart2\n");
  });

  it("getHistoryStats().path reflects historyLogPath", async () => {
    const logPath = path.join(tmpDir, "h.log");
    const h = new SessionHistory({ maxHistoryBytes: 1024, historyLogPath: logPath });
    expect(h.getHistoryStats().path).toBe(logPath);
    await h.endDiskStream();
  });

  it("path is null when not provided", () => {
    const h = new SessionHistory({ maxHistoryBytes: 1024, historyLogPath: null });
    expect(h.getHistoryStats().path).toBe(null);
  });
});

describe("stripAnsi", () => {
  it("removes CSI sequences", () => {
    expect(stripAnsi("\x1b[31mred\x1b[0m")).toBe("red");
    expect(stripAnsi("\x1b[1;38;5;200mfancy\x1b[0m")).toBe("fancy");
  });

  it("removes OSC sequences (BEL terminator)", () => {
    expect(stripAnsi("\x1b]0;title\x07hello")).toBe("hello");
  });

  it("removes OSC sequences (ESC \\ terminator)", () => {
    expect(stripAnsi("\x1b]0;title\x1b\\hello")).toBe("hello");
  });

  it("removes single-char ESC sequences", () => {
    expect(stripAnsi("\x1bDx")).toBe("x");
  });

  it("tolerates dangling head fragment after ring truncation", () => {
    // Ring drops the start of an escape — leaves dangling "[31m" garbage.
    // We don't claim to clean it (regex won't match), but we don't crash.
    const out = stripAnsi("[31mtext\x1b[0m more");
    expect(out).toContain("text");
    expect(out).toContain("more");
  });
});
