/**
 * reviewer — find pending snapshots and accept/reject them.
 *
 * Pure logic separated from CLI: tests drive accept/reject without I/O,
 * the CLI in src/bin/review.ts wraps prompts around these primitives.
 *
 * Per spec §13.2:
 *   accept → mv .snap.new → .snap (overwrite)
 *   reject → rm .snap.new (leave .snap untouched)
 *   --accept-all → batch accept across the tree
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { diffSnapshots } from "./differ.js";
import { parseSnap, readSnap, snapExists } from "./store.js";

// ─── public API ─────────────────────────────────────────────────────────────

export interface PendingEntry {
  /** .snap.new on-disk path. */
  newPath: string;
  /** .snap on-disk path (the target if accepted). May not exist yet (first-run). */
  snapPath: string;
  /** Case name from the candidate's frontmatter. */
  caseName: string;
  /** "new" = first run (no prior .snap), "diff" = mismatch with existing .snap. */
  kind: "new" | "diff";
  /** Computed unified diff (plain section). Empty for kind=new. */
  diff: string;
}

/** Recursively scan `rootDir` for `.snap.new` files. */
export function scanPending(rootDir: string): PendingEntry[] {
  if (!fs.existsSync(rootDir)) return [];
  const out: PendingEntry[] = [];
  walk(rootDir, (file) => {
    if (!file.endsWith(".snap.new")) return;
    const newPath = file;
    const snapPath = file.slice(0, -".new".length);
    const candidate = parseSnap(fs.readFileSync(newPath, "utf8"), newPath);
    if (snapExists(snapPath)) {
      const stored = readSnap(snapPath);
      const d = diffSnapshots({
        expected: stored.plain,
        actual: candidate.plain,
        masks: stored.meta.masks,
      });
      out.push({ newPath, snapPath, caseName: candidate.meta.name, kind: "diff", diff: d.diff });
    } else {
      out.push({ newPath, snapPath, caseName: candidate.meta.name, kind: "new", diff: "" });
    }
  });
  // Stable order: by path so reviewer output is deterministic.
  out.sort((a, b) => (a.newPath < b.newPath ? -1 : 1));
  return out;
}

export function acceptPending(entry: PendingEntry): void {
  fs.mkdirSync(path.dirname(entry.snapPath), { recursive: true });
  fs.renameSync(entry.newPath, entry.snapPath);
}

export function rejectPending(entry: PendingEntry): void {
  try { fs.unlinkSync(entry.newPath); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

export interface BatchResult {
  accepted: number;
  rejected: number;
  /** Caller-decided answers: which entries got accepted vs rejected. */
  decisions: Array<{ entry: PendingEntry; decision: "accept" | "reject" }>;
}

/**
 * Apply a function `decide(entry) → "accept" | "reject" | "quit"` over all
 * pending entries. Returns the tally + per-entry decisions. Used by the
 * CLI's interactive loop AND by tests (decide can be pre-scripted).
 */
export function batch(opts: {
  pending: ReadonlyArray<PendingEntry>;
  decide: (e: PendingEntry, idx: number) => "accept" | "reject" | "quit";
}): BatchResult {
  let accepted = 0;
  let rejected = 0;
  const decisions: BatchResult["decisions"] = [];
  for (let i = 0; i < opts.pending.length; i++) {
    const entry = opts.pending[i]!;
    const d = opts.decide(entry, i);
    if (d === "quit") break;
    if (d === "accept") { acceptPending(entry); accepted++; decisions.push({ entry, decision: "accept" }); }
    else { rejectPending(entry); rejected++; decisions.push({ entry, decision: "reject" }); }
  }
  return { accepted, rejected, decisions };
}

/** Convenience for `--accept-all`. */
export function acceptAll(pending: ReadonlyArray<PendingEntry>): BatchResult {
  return batch({ pending, decide: () => "accept" });
}

// ─── helpers ────────────────────────────────────────────────────────────────

function walk(dir: string, onFile: (file: string) => void): void {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, onFile);
    else if (e.isFile()) onFile(p);
  }
}
