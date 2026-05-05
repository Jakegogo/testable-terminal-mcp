/**
 * Unit tests for the artifact dump module.
 *
 * Round 12 design lets us drive the dump from a synthetic `DumpInput` so we
 * never need to spawn a PTY here. Integration tests cover the live wire.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { dumpArtifacts, defaultDumpDirName, type DumpInput } from "../../src/core/artifacts.js";
import { ErrorCode, isTestableTerminalError } from "../../src/core/errors.js";
import type { TerminalEvent } from "../../src/core/types.js";

let outDir: string;
beforeEach(() => { outDir = fs.mkdtempSync(path.join(os.tmpdir(), "ttm-artifacts-test-")); });
afterEach(() => { fs.rmSync(outDir, { recursive: true, force: true }); });

const baseEvent = (type: TerminalEvent["type"], data?: unknown): TerminalEvent => ({
  type, ts: "2026-05-04T10:00:00.000Z", session_id: "term_test", ...(data !== undefined ? { data } : {}),
});

const sampleInput = (over: Partial<DumpInput> = {}): DumpInput => ({
  sessionId: "term_test_01",
  command: "bash",
  args: ["-il"],
  cwd: "/tmp",
  rows: 24,
  cols: 80,
  status: "exited",
  exitCode: 0,
  exitSignal: undefined,
  createdAt: new Date("2026-05-04T09:59:00.000Z"),
  rawHistory: Buffer.from("\x1b[31mhello\x1b[0m world\n"),
  cleanHistory: "hello world\n",
  rawTruncated: false,
  screenPlain: "hello world\n$ ",
  screenAnsi: "\x1b[31mhello\x1b[0m world\n$ ",
  events: [
    baseEvent("session.created"),
    baseEvent("output.data", { bytes: 19 }),
    baseEvent("process.exit", { exitCode: 0, signal: null }),
  ],
  env: { HOME: "/Users/jake", ANTHROPIC_API_KEY: "sk-ant-secret", PATH: "/usr/bin" },
  redactEnvPatterns: ["*KEY*", "*SECRET*"],
  ...over,
});

describe("dumpArtifacts", () => {
  it("writes the 6 mandatory files (no ANSI snapshot by default)", () => {
    const result = dumpArtifacts(sampleInput(), { outDir });
    expect(result.dir).toBe(outDir);
    expect(result.files.sort()).toEqual([
      "clean.log", "env.json", "events.jsonl", "meta.json", "raw.log", "screen.txt",
    ]);
    expect(result.totalBytes).toBeGreaterThan(0);
    for (const f of result.files) {
      expect(fs.existsSync(path.join(outDir, f))).toBe(true);
    }
  });

  it("includes screen.ansi.txt when includeAnsiSnapshot=true and screenAnsi non-empty", () => {
    const result = dumpArtifacts(sampleInput(), { outDir, includeAnsiSnapshot: true });
    expect(result.files).toContain("screen.ansi.txt");
    const ansi = fs.readFileSync(path.join(outDir, "screen.ansi.txt"), "utf8");
    expect(ansi).toContain("\x1b[31m");
  });

  it("omits screen.ansi.txt when includeAnsiSnapshot=true but screenAnsi empty", () => {
    const result = dumpArtifacts(sampleInput({ screenAnsi: "" }), { outDir, includeAnsiSnapshot: true });
    expect(result.files).not.toContain("screen.ansi.txt");
  });

  it("raw.log preserves bytes verbatim (ANSI included)", () => {
    dumpArtifacts(sampleInput(), { outDir });
    const raw = fs.readFileSync(path.join(outDir, "raw.log"));
    expect(raw.toString("utf8")).toContain("\x1b[31m");
    expect(raw.toString("utf8")).toContain("hello");
  });

  it("clean.log is ANSI-stripped", () => {
    dumpArtifacts(sampleInput(), { outDir });
    const clean = fs.readFileSync(path.join(outDir, "clean.log"), "utf8");
    expect(clean).toBe("hello world\n");
    expect(clean).not.toMatch(/\x1b\[/);
  });

  it("env.json redacts secret-shape keys via patterns", () => {
    dumpArtifacts(sampleInput(), { outDir });
    const env = JSON.parse(fs.readFileSync(path.join(outDir, "env.json"), "utf8"));
    expect(env.HOME).toBe("/Users/jake");
    expect(env.PATH).toBe("/usr/bin");
    expect(env.ANTHROPIC_API_KEY).toBe("***REDACTED***");
  });

  it("events.jsonl contains one JSON object per line, terminated with newline", () => {
    const input = sampleInput();
    dumpArtifacts(input, { outDir });
    const text = fs.readFileSync(path.join(outDir, "events.jsonl"), "utf8");
    const lines = text.split("\n");
    // 3 events + trailing empty line from terminating "\n"
    expect(lines).toHaveLength(input.events.length + 1);
    expect(lines[lines.length - 1]).toBe("");
    for (let i = 0; i < input.events.length; i++) {
      const parsed = JSON.parse(lines[i]!);
      expect(parsed.type).toBe(input.events[i]!.type);
    }
  });

  it("events.jsonl is empty (no trailing newline) when no events", () => {
    dumpArtifacts(sampleInput({ events: [] }), { outDir });
    const text = fs.readFileSync(path.join(outDir, "events.jsonl"), "utf8");
    expect(text).toBe("");
  });

  it("meta.json captures session facts + duration_ms uses opts.now", () => {
    const fixedNow = new Date("2026-05-04T10:00:30.000Z");
    dumpArtifacts(sampleInput(), { outDir, now: () => fixedNow });
    const meta = JSON.parse(fs.readFileSync(path.join(outDir, "meta.json"), "utf8"));
    expect(meta.session_id).toBe("term_test_01");
    expect(meta.command).toBe("bash");
    expect(meta.args).toEqual(["-il"]);
    expect(meta.cwd).toBe("/tmp");
    expect(meta.rows).toBe(24);
    expect(meta.cols).toBe(80);
    expect(meta.status).toBe("exited");
    expect(meta.exit_code).toBe(0);
    expect(meta.exit_signal).toBe(null);
    expect(meta.raw_truncated).toBe(false);
    expect(meta.raw_bytes).toBeGreaterThan(0);
    expect(meta.events_count).toBe(3);
    expect(meta.dumped_at).toBe(fixedNow.toISOString());
    // 09:59:00 → 10:00:30 = 90s
    expect(meta.duration_ms).toBe(90_000);
  });

  it("screen.txt header includes session_id, command, dimensions, status", () => {
    dumpArtifacts(sampleInput(), { outDir });
    const txt = fs.readFileSync(path.join(outDir, "screen.txt"), "utf8");
    expect(txt).toContain("session_id: term_test_01");
    expect(txt).toContain("command: bash -il");
    expect(txt).toContain("rows: 24");
    expect(txt).toContain("cols: 80");
    expect(txt).toContain("status: exited");
    expect(txt).toContain("hello world");
  });

  it("creates outDir recursively if it doesn't exist", () => {
    const nested = path.join(outDir, "deep", "nested", "dump");
    expect(fs.existsSync(nested)).toBe(false);
    dumpArtifacts(sampleInput(), { outDir: nested });
    expect(fs.existsSync(path.join(nested, "raw.log"))).toBe(true);
  });

  it("throws E_TT_ARTIFACT_WRITE_FAILED when outDir cannot be created", () => {
    // Make a file at a path; mkdirSync(file/sub, recursive) fails.
    const filePath = path.join(outDir, "blocker");
    fs.writeFileSync(filePath, "x");
    const target = path.join(filePath, "sub");
    try {
      dumpArtifacts(sampleInput(), { outDir: target });
      expect.fail("should have thrown");
    } catch (err) {
      expect(isTestableTerminalError(err)).toBe(true);
      if (isTestableTerminalError(err)) {
        expect(err.code).toBe(ErrorCode.ARTIFACT_WRITE_FAILED);
      }
    }
  });

  it("captures rawTruncated=true into meta when set", () => {
    dumpArtifacts(sampleInput({ rawTruncated: true }), { outDir });
    const meta = JSON.parse(fs.readFileSync(path.join(outDir, "meta.json"), "utf8"));
    expect(meta.raw_truncated).toBe(true);
  });

  it("captures non-zero exitCode + signal via meta", () => {
    dumpArtifacts(sampleInput({ exitCode: null, exitSignal: 9, status: "killed" }), { outDir });
    const meta = JSON.parse(fs.readFileSync(path.join(outDir, "meta.json"), "utf8"));
    expect(meta.exit_code).toBe(null);
    expect(meta.exit_signal).toBe(9);
    expect(meta.status).toBe("killed");
  });
});

describe("defaultDumpDirName", () => {
  it("produces filesystem-safe slug", () => {
    const ts = new Date("2026-05-04T10:00:00.000Z");
    const slug = defaultDumpDirName("term:abc/def", ts);
    expect(slug).not.toMatch(/[\/:]/);
    expect(slug.startsWith("term_abc_def-")).toBe(true);
  });

  it("encodes ISO timestamp without colons or dots", () => {
    const ts = new Date("2026-05-04T10:00:00.123Z");
    const slug = defaultDumpDirName("name", ts);
    expect(slug).toMatch(/^name-2026-05-04T10-00-00-123Z$/);
  });

  it("handles names with safe chars unchanged", () => {
    const ts = new Date("2026-05-04T10:00:00.000Z");
    const slug = defaultDumpDirName("term_01.run-A", ts);
    expect(slug.startsWith("term_01.run-A-")).toBe(true);
  });
});
