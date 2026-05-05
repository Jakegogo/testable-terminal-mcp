/**
 * differ — apply masks → normalize → produce unified diff.
 *
 * Pure: no fs, no PTY. Tests drive synthetic strings.
 *
 * Mask application order matters (last-write-wins on overlapping matches).
 * We apply masks in array order — caller controls precedence by ordering
 * (presets first, case-level overrides last is the V1 convention).
 *
 * Normalization steps applied AFTER masks, BEFORE compare:
 *   - CRLF → LF (Windows ConPTY normalization)
 *   - strip trailing whitespace per line (terminal padding)
 *   - drop trailing blank lines (terminal scrollback artifact)
 */

import type { SnapMask } from "./store.js";

// ─── public API ─────────────────────────────────────────────────────────────

export interface DiffResult {
  matched: boolean;
  /** Unified diff (empty when matched). */
  diff: string;
  /** Masked + normalized expected text. */
  expected: string;
  /** Masked + normalized actual text. */
  actual: string;
}

export function applyMasks(text: string, masks: ReadonlyArray<SnapMask>): string {
  let out = text;
  for (const m of masks) {
    const flags = m.flags ?? "g";
    out = out.replace(new RegExp(m.pattern, flags), m.replace);
  }
  return out;
}

export function normalize(text: string): string {
  // CRLF → LF + strip trailing whitespace + drop trailing blank lines.
  const noCR = text.replace(/\r\n/g, "\n");
  const lines = noCR.split("\n").map((l) => l.replace(/[ \t]+$/, ""));
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n");
}

export function diffSnapshots(opts: {
  expected: string;
  actual: string;
  masks: ReadonlyArray<SnapMask>;
}): DiffResult {
  const e = normalize(applyMasks(opts.expected, opts.masks));
  const a = normalize(applyMasks(opts.actual, opts.masks));
  if (e === a) return { matched: true, diff: "", expected: e, actual: a };
  return { matched: false, diff: unifiedDiff(e, a), expected: e, actual: a };
}

// ─── unified diff ───────────────────────────────────────────────────────────

/**
 * Minimal unified diff. Not RFC-compliant — just enough for human-readable
 * snapshot review. We include 3 lines of context around each change.
 *
 * For larger diffs the Myers algorithm would give a tighter result, but
 * snapshots are typically small (<200 lines) and the naive line-by-line
 * compare with merged hunks is more than enough for visual review.
 */
export function unifiedDiff(before: string, after: string, contextLines = 3): string {
  if (before === after) return "";
  const a = before.split("\n");
  const b = after.split("\n");
  const ops = lcsOps(a, b);

  if (ops.length === 0 || ops.every((o) => o.kind === "eq")) return "";

  const out: string[] = ["--- expected", "+++ actual"];
  let i = 0;
  while (i < ops.length) {
    // Skip equal runs.
    while (i < ops.length && ops[i]!.kind === "eq") i++;
    if (i >= ops.length) break;

    // Collect a hunk.
    const hunkStart = Math.max(0, i - contextLines);
    let j = i;
    while (j < ops.length) {
      if (ops[j]!.kind !== "eq") { j++; continue; }
      // Look ahead: if more changes within `contextLines`, keep going.
      let k = j;
      while (k < ops.length && ops[k]!.kind === "eq") k++;
      if (k - j >= contextLines * 2 || k >= ops.length) {
        // Stop here; trailing context = up to `contextLines`.
        j = j + Math.min(contextLines, k - j);
        break;
      }
      j = k;
    }
    if (j > ops.length) j = ops.length;

    out.push(formatHunkHeader(ops, hunkStart, j));
    for (let k = hunkStart; k < j; k++) {
      const o = ops[k]!;
      out.push((o.kind === "eq" ? " " : o.kind === "del" ? "-" : "+") + o.line);
    }
    i = j;
  }
  return out.join("\n");
}

interface DiffOp { kind: "eq" | "del" | "add"; line: string; aIdx: number; bIdx: number }

/**
 * Produce a sequence of edit ops via a simple LCS dp. O(n*m) memory.
 * For the snapshot scale (typically <1000 lines), this is fine.
 */
function lcsOps(a: string[], b: string[]): DiffOp[] {
  const n = a.length, m = b.length;
  // dp[i][j] = LCS length of a[0..i] vs b[0..j].
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (a[i - 1] === b[j - 1]) dp[i]![j] = dp[i - 1]![j - 1]! + 1;
      else dp[i]![j] = Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
    }
  }
  // Walk back.
  const ops: DiffOp[] = [];
  let i = n, j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      ops.unshift({ kind: "eq", line: a[i - 1]!, aIdx: i - 1, bIdx: j - 1 });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i]![j - 1]! >= dp[i - 1]![j]!)) {
      ops.unshift({ kind: "add", line: b[j - 1]!, aIdx: i, bIdx: j - 1 });
      j--;
    } else if (i > 0) {
      ops.unshift({ kind: "del", line: a[i - 1]!, aIdx: i - 1, bIdx: j });
      i--;
    }
  }
  return ops;
}

function formatHunkHeader(ops: ReadonlyArray<DiffOp>, start: number, end: number): string {
  let aStart = -1, aLines = 0;
  let bStart = -1, bLines = 0;
  for (let k = start; k < end; k++) {
    const o = ops[k]!;
    if (o.kind !== "add") {
      if (aStart < 0) aStart = o.aIdx + 1;
      aLines++;
    }
    if (o.kind !== "del") {
      if (bStart < 0) bStart = o.bIdx + 1;
      bLines++;
    }
  }
  if (aStart < 0) aStart = 1;
  if (bStart < 0) bStart = 1;
  return `@@ -${aStart},${aLines} +${bStart},${bLines} @@`;
}
