/**
 * Unit tests for the .snap store — round-trip parse/format + structural
 * error coverage.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  formatSnap, parseSnap, readSnap, snapshotPath, pendingPath, writeSnap,
  type SnapFile,
} from "../../src/core/snapshot-test/store.js";
import { ErrorCode, isTestableTerminalError } from "../../src/core/errors.js";

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "ttm-snap-store-")); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const sample = (over: Partial<SnapFile> = {}): SnapFile => ({
  meta: {
    name: "claude_simple",
    createdAt: "2026-05-04T12:00:00.000Z",
    updatedAt: "2026-05-04T12:00:00.000Z",
    session: { command: "claude", rows: 40, cols: 120, sandbox: "ephemeral" },
    masks: [{ pattern: "pid=\\d+", replace: "pid=<MASKED>" }],
    includeAnsi: false,
  },
  plain: "╭── Claude Code ──╮\nHello world\n",
  ansi: null,
  ...over,
});

describe("snapshot store — round-trip", () => {
  it("write then read yields identical SnapFile", () => {
    const file = path.join(dir, "case.snap");
    const original = sample();
    writeSnap(file, original);
    const loaded = readSnap(file);
    expect(loaded.meta.name).toBe(original.meta.name);
    expect(loaded.meta.session).toEqual(original.meta.session);
    expect(loaded.meta.masks).toEqual(original.meta.masks);
    expect(loaded.plain).toBe(original.plain.replace(/\n+$/, ""));
    expect(loaded.ansi).toBe(null);
  });

  it("ANSI section round-trips when include_ansi=true", () => {
    const file = path.join(dir, "ansi.snap");
    const original = sample({
      meta: { ...sample().meta, includeAnsi: true },
      ansi: "\x1b[31mRED\x1b[0m\n",
    });
    writeSnap(file, original);
    const loaded = readSnap(file);
    expect(loaded.meta.includeAnsi).toBe(true);
    expect(loaded.ansi).toBe("\x1b[31mRED\x1b[0m");
  });

  it("masks list with multiple entries round-trips", () => {
    const original = sample({
      meta: {
        ...sample().meta,
        masks: [
          { pattern: "v\\d+\\.\\d+", replace: "v<MASKED>" },
          { pattern: "\\d{4}-\\d{2}-\\d{2}", replace: "<DATE>" },
        ],
      },
    });
    const text = formatSnap(original);
    const parsed = parseSnap(text);
    expect(parsed.meta.masks).toEqual(original.meta.masks);
  });

  it("empty session block omitted from output", () => {
    const original = sample({ meta: { ...sample().meta, session: undefined } });
    const text = formatSnap(original);
    expect(text).not.toContain("session:");
  });
});

describe("snapshot store — paths", () => {
  it("snapshotPath sanitizes test file id and case name", () => {
    const p = snapshotPath("/snap", "tests/foo bar.test.ts", "case with: weird/chars");
    expect(p).toMatch(/^\/snap\/tests_foo_bar\.test\.ts\/case_with__weird_chars\.snap$/);
  });

  it("pendingPath appends .new", () => {
    expect(pendingPath("/x/y/case.snap")).toBe("/x/y/case.snap.new");
  });
});

describe("snapshot store — structural errors", () => {
  it("missing leading --- → SNAPSHOT_STORE_CORRUPT", () => {
    try {
      parseSnap("name: x\n---\n== plain ==\nfoo");
      expect.fail("should have thrown");
    } catch (err) {
      expect(isTestableTerminalError(err)).toBe(true);
      if (isTestableTerminalError(err)) expect(err.code).toBe(ErrorCode.SNAPSHOT_STORE_CORRUPT);
    }
  });

  it("unterminated frontmatter → SNAPSHOT_STORE_CORRUPT", () => {
    try {
      parseSnap("---\nname: x\n");
      expect.fail("should have thrown");
    } catch (err) {
      expect(isTestableTerminalError(err)).toBe(true);
    }
  });

  it("unknown top-level key → SNAPSHOT_STORE_CORRUPT", () => {
    try {
      parseSnap("---\nname: x\nbogus: 1\n---\n== plain ==\nfoo");
      expect.fail("should have thrown");
    } catch (err) {
      expect(isTestableTerminalError(err)).toBe(true);
    }
  });

  it("missing 'name' → SNAPSHOT_STORE_CORRUPT", () => {
    try {
      parseSnap("---\ncreated_at: x\n---\n== plain ==\nfoo");
      expect.fail("should have thrown");
    } catch (err) {
      expect(isTestableTerminalError(err)).toBe(true);
    }
  });

  it("include_ansi=true but no ansi section → SNAPSHOT_STORE_CORRUPT", () => {
    try {
      parseSnap("---\nname: x\ncreated_at: t\nupdated_at: t\ninclude_ansi: true\n---\n== plain ==\nfoo");
      expect.fail("should have thrown");
    } catch (err) {
      expect(isTestableTerminalError(err)).toBe(true);
    }
  });

  it("include_ansi=false but ansi section present → SNAPSHOT_STORE_CORRUPT", () => {
    try {
      parseSnap("---\nname: x\ncreated_at: t\nupdated_at: t\ninclude_ansi: false\n---\n== plain ==\nfoo\n== ansi ==\nbar");
      expect.fail("should have thrown");
    } catch (err) {
      expect(isTestableTerminalError(err)).toBe(true);
    }
  });

  it("malformed mask entry → SNAPSHOT_STORE_CORRUPT", () => {
    try {
      parseSnap("---\nname: x\ncreated_at: t\nupdated_at: t\nmasks:\n  - not-an-object\ninclude_ansi: false\n---\n== plain ==\nfoo");
      expect.fail("should have thrown");
    } catch (err) {
      expect(isTestableTerminalError(err)).toBe(true);
    }
  });
});
