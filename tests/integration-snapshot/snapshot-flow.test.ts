/**
 * M7 acceptance — full snapshot flow.
 *
 * Cases per spec:
 *   first-run-pending   → write .snap.new + throw SNAPSHOT_PENDING
 *   match-pass          → identical actual; pass; no .new written
 *   mismatch-fail       → modified actual; throw SNAPSHOT_MISMATCH + write .snap.new
 *   mask-applied        → mask hides dynamic field; previously-failing case passes
 *   review-accept       → scripted decide function accepts; .snap.new → .snap
 *   review-reject       → scripted decide function rejects; .snap.new removed; .snap intact
 *   review-batch-accept → --accept-all
 *
 * Uses real fs but synthetic actual strings (no PTY).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  assertSnapshot, snapshotPath, pendingPath,
} from "../../src/core/snapshot-test/index.js";
import {
  scanPending, batch, acceptAll,
} from "../../src/core/snapshot-test/reviewer.js";
import { ErrorCode, isTestableTerminalError } from "../../src/core/errors.js";

let rootDir: string;
beforeEach(() => { rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ttm-snap-int-")); });
afterEach(() => { fs.rmSync(rootDir, { recursive: true, force: true }); });

const TEST_FILE = "snapshot-flow.test.ts";

describe("snapshot flow — first run", () => {
  it("first-run-pending: writes .snap.new + throws SNAPSHOT_PENDING", () => {
    const caseName = "first_run";
    try {
      assertSnapshot({
        rootDir,
        testFileId: TEST_FILE,
        caseName,
        actual: { plain: "hello pid=123" },
      });
      expect.fail("should have thrown");
    } catch (err) {
      expect(isTestableTerminalError(err)).toBe(true);
      if (isTestableTerminalError(err)) {
        expect(err.code).toBe(ErrorCode.SNAPSHOT_PENDING);
      }
    }
    // .snap.new exists; .snap does not.
    const snap = snapshotPath(rootDir, TEST_FILE, caseName);
    const newP = pendingPath(snap);
    expect(fs.existsSync(snap)).toBe(false);
    expect(fs.existsSync(newP)).toBe(true);
    const content = fs.readFileSync(newP, "utf8");
    expect(content).toContain("name: first_run");
    expect(content).toContain("hello pid=123");
  });
});

describe("snapshot flow — match", () => {
  it("match-pass: identical actual + accepted snapshot → pass, no .new written", () => {
    const caseName = "stable";
    const opts = {
      rootDir, testFileId: TEST_FILE, caseName,
      actual: { plain: "stable output" },
    };
    // First run: pending.
    expect(() => assertSnapshot(opts)).toThrow();

    // Promote .new → .snap (mimics user accept).
    const snap = snapshotPath(rootDir, TEST_FILE, caseName);
    fs.renameSync(pendingPath(snap), snap);

    // Re-run with same actual → pass + no new file written.
    const r = assertSnapshot(opts);
    expect(r.matched).toBe(true);
    expect(fs.existsSync(pendingPath(snap))).toBe(false);
  });
});

describe("snapshot flow — mismatch", () => {
  it("mismatch-fail: actual changed → throws SNAPSHOT_MISMATCH + writes .snap.new with diff", () => {
    const caseName = "drift";
    const baseOpts = {
      rootDir, testFileId: TEST_FILE, caseName,
    };
    // First run + accept.
    try { assertSnapshot({ ...baseOpts, actual: { plain: "v1" } }); } catch { /* expected */ }
    const snap = snapshotPath(rootDir, TEST_FILE, caseName);
    fs.renameSync(pendingPath(snap), snap);

    // Different actual → mismatch.
    try {
      assertSnapshot({ ...baseOpts, actual: { plain: "v2" } });
      expect.fail("should have thrown");
    } catch (err) {
      expect(isTestableTerminalError(err)).toBe(true);
      if (isTestableTerminalError(err)) {
        expect(err.code).toBe(ErrorCode.SNAPSHOT_MISMATCH);
        const diff = (err.details as { diff: string }).diff;
        expect(diff).toContain("-v1");
        expect(diff).toContain("+v2");
      }
    }
    // .snap intact, .snap.new written.
    expect(fs.readFileSync(snap, "utf8")).toContain("v1");
    expect(fs.readFileSync(pendingPath(snap), "utf8")).toContain("v2");
  });
});

describe("snapshot flow — mask hides dynamic field", () => {
  it("mask-applied: dynamic field changes but mask makes them equivalent → pass", () => {
    const caseName = "with_pid";
    const baseOpts = {
      rootDir, testFileId: TEST_FILE, caseName,
      maskPresets: ["claude-tui"],
    };
    // First run + accept.
    try { assertSnapshot({ ...baseOpts, actual: { plain: "claude pid=123 ready" } }); } catch { /* expected */ }
    const snap = snapshotPath(rootDir, TEST_FILE, caseName);
    fs.renameSync(pendingPath(snap), snap);

    // Different pid → still passes via claude-tui mask.
    const r = assertSnapshot({ ...baseOpts, actual: { plain: "claude pid=999 ready" } });
    expect(r.matched).toBe(true);
  });
});

describe("snapshot flow — reviewer scan + decisions", () => {
  // Helper: drop two pending snapshots to review.
  const setupTwoPending = (): void => {
    try { assertSnapshot({ rootDir, testFileId: TEST_FILE, caseName: "case_a", actual: { plain: "case A" } }); } catch { /* expected */ }
    try { assertSnapshot({ rootDir, testFileId: TEST_FILE, caseName: "case_b", actual: { plain: "case B" } }); } catch { /* expected */ }
  };

  it("scanPending finds both .snap.new entries", () => {
    setupTwoPending();
    const list = scanPending(rootDir);
    expect(list.length).toBe(2);
    expect(list.map((e) => e.caseName).sort()).toEqual(["case_a", "case_b"]);
    expect(list.every((e) => e.kind === "new")).toBe(true);
  });

  it("review-accept: scripted decide accept → .snap.new → .snap, .snap intact", () => {
    setupTwoPending();
    const pending = scanPending(rootDir);
    const r = batch({ pending, decide: () => "accept" });
    expect(r.accepted).toBe(2);
    expect(r.rejected).toBe(0);
    for (const e of pending) {
      expect(fs.existsSync(e.snapPath)).toBe(true);
      expect(fs.existsSync(e.newPath)).toBe(false);
    }
  });

  it("review-reject: scripted decide reject → .snap.new removed, .snap untouched", () => {
    setupTwoPending();
    const pending = scanPending(rootDir);
    const r = batch({ pending, decide: () => "reject" });
    expect(r.accepted).toBe(0);
    expect(r.rejected).toBe(2);
    for (const e of pending) {
      expect(fs.existsSync(e.snapPath)).toBe(false); // first-run, .snap never existed
      expect(fs.existsSync(e.newPath)).toBe(false);
    }
  });

  it("review-quit: stops mid-stream", () => {
    setupTwoPending();
    const pending = scanPending(rootDir);
    const r = batch({ pending, decide: (_e, idx) => idx === 0 ? "accept" : "quit" });
    expect(r.accepted).toBe(1);
    expect(r.rejected).toBe(0);
    expect(r.decisions.length).toBe(1);
  });

  it("review-batch-accept-all: --accept-all promotes everything", () => {
    setupTwoPending();
    const pending = scanPending(rootDir);
    const r = acceptAll(pending);
    expect(r.accepted).toBe(2);
    for (const e of pending) {
      expect(fs.existsSync(e.snapPath)).toBe(true);
      expect(fs.existsSync(e.newPath)).toBe(false);
    }
  });

  it("scanPending classifies kind=diff when prior .snap exists", () => {
    // Round 1: first-run + accept.
    try { assertSnapshot({ rootDir, testFileId: TEST_FILE, caseName: "drift", actual: { plain: "old" } }); } catch { /* expected */ }
    const snap = snapshotPath(rootDir, TEST_FILE, "drift");
    fs.renameSync(pendingPath(snap), snap);

    // Round 2: mismatch writes .snap.new.
    try { assertSnapshot({ rootDir, testFileId: TEST_FILE, caseName: "drift", actual: { plain: "new" } }); } catch { /* expected */ }

    const list = scanPending(rootDir);
    expect(list.length).toBe(1);
    expect(list[0]!.kind).toBe("diff");
    expect(list[0]!.diff).toContain("-old");
    expect(list[0]!.diff).toContain("+new");
  });
});

describe("snapshot flow — ANSI section", () => {
  it("includeAnsi=true round-trip + diff", () => {
    const caseName = "ansi_case";
    const opts = {
      rootDir, testFileId: TEST_FILE, caseName, includeAnsi: true,
      actual: { plain: "OK", ansi: "\x1b[32mOK\x1b[0m" },
    };
    try { assertSnapshot(opts); } catch { /* expected */ }
    const snap = snapshotPath(rootDir, TEST_FILE, caseName);
    fs.renameSync(pendingPath(snap), snap);

    // Same actual → match.
    const r = assertSnapshot(opts);
    expect(r.matched).toBe(true);

    // Modified ANSI → mismatch.
    expect(() => assertSnapshot({
      ...opts, actual: { plain: "OK", ansi: "\x1b[31mOK\x1b[0m" },
    })).toThrow();
  });
});
