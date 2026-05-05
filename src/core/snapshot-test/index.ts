/**
 * assertSnapshot — main entry point for snapshot test cases.
 *
 * Per spec §13.2:
 *
 *   .snap not present  → write .snap.new + throw E_TT_SNAPSHOT_PENDING
 *   .snap present + match  → pass (no .new written; if .snap.new exists, leave it)
 *   .snap present + mismatch → write .snap.new + throw E_TT_SNAPSHOT_MISMATCH
 *
 * Caller controls:
 *   - rootDir              (config.snapshot.rootDir, default tests/__snapshots__)
 *   - testFileId           (vitest's `expect.getState().testPath` slug-ified)
 *   - caseName             (caller-chosen, e.g. "claude_simple_question")
 *   - masks (preset names + inline)
 *   - includeAnsi          (opt-in, off by default per P2-2 decision)
 *   - actual { plain, ansi? }
 *   - session metadata (command/rows/cols/sandbox), recorded for traceability
 *
 * Round-12 design decision: assertSnapshot is a *standalone* function, not a
 * Session method. Callers may snapshot anything (the screen of a session, a
 * captured env JSON, a flat log file). Sessions are the most common source
 * but not the only one.
 */

import { ErrorCode, TestableTerminalError } from "../errors.js";
import { diffSnapshots } from "./differ.js";
import { resolveMasks } from "./masks.js";
import {
  formatSnap, parseSnap, pendingPath, readSnap, snapExists, snapshotPath, writeSnap,
  type SnapFile, type SnapMask, type SnapMeta,
} from "./store.js";

// ─── public API ─────────────────────────────────────────────────────────────

export interface AssertSnapshotOpts {
  /** Where snapshot files live. */
  rootDir: string;
  /** Test file scoping (e.g. `"tests/claude.test.ts"` slug-ified). */
  testFileId: string;
  /** Case name within the test file. */
  caseName: string;
  /** Preset mask names. Resolved against masks.ts PRESETS. */
  maskPresets?: ReadonlyArray<string>;
  /** Inline masks (case-level). Applied after presets in order. */
  masks?: ReadonlyArray<SnapMask>;
  /** Capture ANSI section in addition to plain (default false per P2-2). */
  includeAnsi?: boolean;
  /** The captured screen text. */
  actual: { plain: string; ansi?: string };
  /** Optional session metadata, written into frontmatter. */
  session?: Record<string, unknown>;
  /** Override clock for testing. */
  now?: () => Date;
}

export interface AssertSnapshotResult {
  matched: boolean;
  /** Resolved on-disk path of the .snap (or .snap.new on first run / mismatch). */
  snapshotPath: string;
  /** When mismatch / pending, the .snap.new path that was written. */
  pendingPath?: string;
  /** Unified diff text on mismatch (empty otherwise). */
  diff?: string;
}

export function assertSnapshot(opts: AssertSnapshotOpts): AssertSnapshotResult {
  const now = opts.now ?? (() => new Date());
  const masks = resolveMasks(opts.maskPresets ?? [], opts.masks ?? []);
  const includeAnsi = opts.includeAnsi ?? false;

  const snapPath = snapshotPath(opts.rootDir, opts.testFileId, opts.caseName);
  const newPath = pendingPath(snapPath);

  const buildSnap = (): SnapFile => {
    const meta: SnapMeta = {
      name: opts.caseName,
      createdAt: now().toISOString(),
      updatedAt: now().toISOString(),
      session: opts.session,
      masks,
      includeAnsi,
    };
    return {
      meta,
      plain: opts.actual.plain,
      ansi: includeAnsi ? (opts.actual.ansi ?? "") : null,
    };
  };

  // Branch 1: no stored snapshot → first run.
  if (!snapExists(snapPath)) {
    const snap = buildSnap();
    writeSnap(newPath, snap);
    throw new TestableTerminalError(
      ErrorCode.SNAPSHOT_PENDING,
      `snapshot pending: ${opts.caseName} (run \`ttm-review\` to accept)`,
      {
        snapshotPath: snapPath, pendingPath: newPath,
        hint: "first run for this snapshot — review the candidate and run `ttm-review` to promote it",
      },
    );
  }

  // Branch 2: stored snapshot exists → compare.
  const stored = readSnap(snapPath);
  // We diff against the snapshot's own masks (not the test's invocation),
  // matching insta semantics: the .snap captures both what was masked AND
  // the result. Caller-provided masks only apply on first-run / mismatch
  // when we WRITE a new candidate.
  const plainDiff = diffSnapshots({
    expected: stored.plain,
    actual: opts.actual.plain,
    masks: stored.meta.masks,
  });

  let ansiDiff = { matched: true, diff: "", expected: "", actual: "" };
  if (stored.meta.includeAnsi) {
    ansiDiff = diffSnapshots({
      expected: stored.ansi ?? "",
      actual: opts.actual.ansi ?? "",
      masks: stored.meta.masks,
    });
  }

  if (plainDiff.matched && ansiDiff.matched) {
    return { matched: true, snapshotPath: snapPath };
  }

  // Mismatch: write a candidate using the *current invocation's* masks
  // (so reviewer-accept yields the new mask set as well).
  const candidate = buildSnap();
  writeSnap(newPath, candidate);

  // Compose a single combined diff message.
  const diffParts: string[] = [];
  if (!plainDiff.matched) diffParts.push("[plain]\n" + plainDiff.diff);
  if (!ansiDiff.matched) diffParts.push("[ansi]\n" + ansiDiff.diff);
  const combined = diffParts.join("\n");

  throw new TestableTerminalError(
    ErrorCode.SNAPSHOT_MISMATCH,
    `snapshot mismatch: ${opts.caseName}`,
    {
      snapshotPath: snapPath, pendingPath: newPath, diff: combined,
      hint: "review the diff with `ttm-review` and accept or reject",
    },
  );
}

// Re-export common helpers so callers don't need deep imports.
export { resolveMasks, parseSnap, formatSnap, snapshotPath, pendingPath };
export type { SnapFile, SnapMeta, SnapMask };
