/**
 * assert.file_unchanged — the named file's sha256 matches a baseline.
 *
 * Lookup precedence:
 *   1. caller-passed baselineId, if any
 *   2. most recently captured baseline matching `path` (last write wins)
 *
 * "Unchanged" semantics:
 *   baseline.sha256 === null && current.sha256 === null   → pass (still absent)
 *   baseline.sha256 === current.sha256                     → pass
 *   any other combination                                  → ASSERT_FILE_CHANGED
 *
 * The error message includes a unified diff of text content so failure
 * messages tell the human what changed without needing to grep the artifact
 * dump.
 */

import * as path from "node:path";
import { ErrorCode, TestableTerminalError } from "../../errors.js";
import {
  hashFile, findBaseline, noBaselineError, readTextOrEmpty, unifiedDiff,
} from "../file-baseline.js";
import type { FileBaseline, SandboxRef } from "../../types.js";

export interface AssertFileUnchangedOpts {
  sandbox: SandboxRef;
  /** sandbox-relative or absolute path to compare. */
  path: string;
  /** Snapshot of baselines to look up against. */
  baselines: ReadonlyArray<FileBaseline>;
  /** Optional explicit baseline id; when omitted we use the latest match. */
  baselineId?: string;
  /** Override clock for testing. */
  now?: () => Date;
}

export function assertFileUnchanged(opts: AssertFileUnchangedOpts): void {
  const baseline = findBaseline(opts.baselines, opts.path, opts.baselineId);
  if (!baseline) noBaselineError(opts.path, opts.baselineId);

  const abs = path.isAbsolute(opts.path) ? opts.path : path.join(opts.sandbox.path, opts.path);
  const current = hashFile({
    id: "assert-current",
    path: opts.path,
    absolutePath: abs,
    now: opts.now,
  });

  if (baseline.sha256 === current.sha256) return;

  // Diff context: prefer the baseline's cached content (captured at hash
  // time, before any change) over re-reading post-change. Re-read for the
  // current side. When either side is binary / oversized, content may be
  // null; computeDiffMessage handles that.
  const before = baseline.content ?? "";
  const after = current.content ?? readTextOrEmpty(abs);
  const diff = computeDiffMessage(baseline, current, before, after);

  throw new TestableTerminalError(
    ErrorCode.ASSERT_FILE_CHANGED,
    `file changed since baseline "${baseline.id}": ${opts.path}`,
    {
      path: opts.path,
      baselineId: baseline.id,
      baselineSha256: baseline.sha256,
      currentSha256: current.sha256,
      diff,
    },
  );
}

function computeDiffMessage(
  baseline: FileBaseline,
  current: FileBaseline,
  beforeText: string,
  afterText: string,
): string {
  if (baseline.sha256 === null && current.sha256 !== null) return "(new file appeared, was absent at baseline)";
  if (baseline.sha256 !== null && current.sha256 === null) return "(file was deleted since baseline)";
  // Both present, content differs.
  return unifiedDiff(beforeText, afterText);
}
