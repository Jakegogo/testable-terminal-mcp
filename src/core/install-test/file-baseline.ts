/**
 * file-baseline — sha256 a file (or list of files) at a known point so later
 * `assert.file_unchanged` / `idempotent_install` can compare.
 *
 * Two flavors:
 *   - autoBaseline()        — at session create, hash the standard rc files
 *                             so callers can assert "installer didn't touch
 *                             .bashrc" without explicit baseline calls.
 *   - hashFile() / hashAll() — pure helpers, used by the explicit baseline
 *                             flow + by idempotent-install rounds.
 *
 * Pure I/O on the host fs (sandbox is a host dir). No PTY, no env.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { ErrorCode, TestableTerminalError } from "../errors.js";
import type { FileBaseline, SandboxRef } from "../types.js";

// ─── public types ────────────────────────────────────────────────────────────

export interface AutoBaselineOpts {
  sandbox: SandboxRef;
  /** Override the standard list (e.g. limit to .bashrc only for tests). */
  paths?: ReadonlyArray<string>;
  /** Override clock for testing. */
  now?: () => Date;
}

/**
 * The standard rc files we baseline at session create. These are sandbox-
 * relative; resolution happens against `sandbox.path`. Missing files are
 * recorded as `sha256: null, size: null` (not an error — installer might
 * create them later).
 */
export const DEFAULT_RC_FILES: ReadonlyArray<string> = [
  ".zshrc", ".zprofile", ".zshenv", ".zlogin",
  ".bashrc", ".bash_profile", ".bash_login", ".profile",
  ".aikey/config.json",
  "Documents/PowerShell/Profile.ps1",
];

// ─── public API ──────────────────────────────────────────────────────────────

/**
 * Hash the standard rc files inside a sandbox. Returns one FileBaseline per
 * configured path (whether the file exists or not — absent → sha256=null).
 *
 * The baseline `id` is a stable string ("session-create") chosen so most
 * callers don't need to remember a unique id — they can ask
 * `assertFileUnchanged(".bashrc")` without specifying which baseline.
 */
export function autoBaseline(opts: AutoBaselineOpts): FileBaseline[] {
  const now = opts.now ?? (() => new Date());
  const id = "session-create";
  const paths = opts.paths ?? DEFAULT_RC_FILES;
  return paths.map((rel) => {
    const abs = path.join(opts.sandbox.path, rel);
    return hashFile({ id, path: rel, absolutePath: abs, now });
  });
}

export interface HashFileOpts {
  /** Baseline id for this snapshot (e.g. "session-create"). */
  id: string;
  /** Stored in the baseline as the "key" — usually sandbox-relative. */
  path: string;
  /** Resolved absolute path on host fs. */
  absolutePath: string;
  /** Override clock. */
  now?: () => Date;
}

/** Files larger than this are not content-cached (only sha256 + size). */
const MAX_CONTENT_CACHE_BYTES = 1_048_576; // 1MB

/**
 * Hash a single file. Returns `sha256: null, size: null, content: null`
 * when the path doesn't exist (so callers can detect "file appeared after
 * install" by comparing against the absent baseline). For text files under
 * 1MB, the original UTF-8 content is cached so `assertFileUnchanged` can
 * produce a real unified diff without re-reading.
 */
export function hashFile(opts: HashFileOpts): FileBaseline {
  const now = opts.now ?? (() => new Date());
  if (!fs.existsSync(opts.absolutePath)) {
    return { id: opts.id, path: opts.path, sha256: null, size: null, content: null, capturedAt: now().toISOString() };
  }
  const stat = fs.statSync(opts.absolutePath);
  if (!stat.isFile()) {
    return { id: opts.id, path: opts.path, sha256: null, size: null, content: null, capturedAt: now().toISOString() };
  }
  const buf = fs.readFileSync(opts.absolutePath);
  const sha = crypto.createHash("sha256").update(buf).digest("hex");
  let content: string | null = null;
  if (stat.size <= MAX_CONTENT_CACHE_BYTES && !looksBinary(buf)) {
    content = buf.toString("utf8");
  }
  return { id: opts.id, path: opts.path, sha256: sha, size: stat.size, content, capturedAt: now().toISOString() };
}

/** Heuristic: presence of NUL bytes in the leading window ⇒ binary. */
function looksBinary(buf: Buffer): boolean {
  const head = buf.subarray(0, Math.min(8192, buf.length));
  for (let i = 0; i < head.length; i++) if (head[i] === 0) return true;
  return false;
}

/**
 * Hash a list of paths (sandbox-relative or absolute). Used by
 * idempotent_install to capture file state between rounds.
 */
export function hashAll(opts: {
  id: string;
  sandbox: SandboxRef;
  paths: ReadonlyArray<string>;
  now?: () => Date;
}): FileBaseline[] {
  const now = opts.now ?? (() => new Date());
  return opts.paths.map((rel) => {
    const abs = path.isAbsolute(rel) ? rel : path.join(opts.sandbox.path, rel);
    return hashFile({ id: opts.id, path: rel, absolutePath: abs, now });
  });
}

// ─── unified diff (used by file_unchanged failure messages) ────────────────

/**
 * Generate a tiny unified diff between two strings. Not a full RFC 2855 impl
 * — just enough context for human-readable assert failure messages.
 */
export function unifiedDiff(before: string, after: string, opts: { contextLines?: number } = {}): string {
  if (before === after) return "";
  const a = before.split(/\r?\n/);
  const b = after.split(/\r?\n/);
  const ctx = opts.contextLines ?? 2;

  // Naive: report all changed lines marked with `+`/`-`. For larger files
  // this is verbose but fits a human-readable assert message; the assertion
  // is about correctness, not minimal diff.
  const out: string[] = [];
  out.push("--- before");
  out.push("+++ after");
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i++) {
    const av = i < a.length ? a[i] : undefined;
    const bv = i < b.length ? b[i] : undefined;
    if (av === bv) {
      // Show context only when adjacent to a change. To keep this simple,
      // always show a few leading/trailing context lines.
      if (out.length <= 2 + ctx) out.push(` ${av ?? ""}`);
      continue;
    }
    if (av !== undefined) out.push(`-${av}`);
    if (bv !== undefined) out.push(`+${bv}`);
  }
  return out.join("\n");
}

/** Read a file as text, returning "" if absent. Used by diff messages. */
export function readTextOrEmpty(absolutePath: string): string {
  try {
    return fs.readFileSync(absolutePath, "utf8");
  } catch {
    return "";
  }
}

/** Lookup a baseline entry by path. Pure helper for assert callers. */
export function findBaseline(
  baselines: ReadonlyArray<FileBaseline>,
  pathKey: string,
  baselineId?: string,
): FileBaseline | null {
  for (let i = baselines.length - 1; i >= 0; i--) {
    const e = baselines[i]!;
    if (e.path === pathKey && (baselineId === undefined || e.id === baselineId)) return e;
  }
  return null;
}

/** Throw a structured "no baseline for X" error so call sites are uniform. */
export function noBaselineError(pathKey: string, baselineId?: string): never {
  throw new TestableTerminalError(
    ErrorCode.INVALID_INPUT,
    `no baseline found for path "${pathKey}"${baselineId ? ` with id "${baselineId}"` : ""}`,
    { hint: "call file_baseline.snapshot(path) before the change you want to assert against", pathKey, baselineId },
  );
}
