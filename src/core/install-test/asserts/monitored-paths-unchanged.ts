/**
 * assert.monitored_paths_unchanged — installer must not touch host paths
 * outside the sandbox.
 *
 * "deny-list" semantics (per spec §11.6.2): we don't claim to enforce full
 * fs isolation. We baseline a configured list of paths (default: /etc rc
 * files, /usr/local/bin, /opt/homebrew, ...). Caller may extend the list.
 * After running the installer command, we re-stat + re-hash each path and
 * surface anything that changed.
 *
 * CI mocking note: the round-12 acceptance plan mounts a tmpdir over the
 * default list so concurrent CI jobs don't collide. Tests for
 * `leaks-to-host.sh` use a caller-supplied list pointing at a fixture path,
 * sidestepping the real /etc/zshrc.
 *
 * Performance: directories monitor only their immediate children's mtime +
 * count, not file content (large /usr/local/bin is too expensive to hash
 * end-to-end).
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { ErrorCode, TestableTerminalError } from "../../errors.js";
import type { MonitoredPathLeak } from "../../types.js";

// ─── public API ──────────────────────────────────────────────────────────────

export interface MonitoredPathBaseline {
  path: string;
  /** "absent" = path didn't exist at baseline. */
  kind: "file" | "dir" | "absent";
  /** sha256 of file contents (file kind only); null otherwise. */
  sha256: string | null;
  /** Directory: hash of {childName + size + mtimeMs} list (sorted). */
  dirHash: string | null;
  size: number | null;
  mtimeMs: number | null;
}

export interface AssertMonitoredPathsOpts {
  /** Snapshot taken before the command. */
  before: ReadonlyArray<MonitoredPathBaseline>;
  /** Same paths, snapshot after. */
  after: ReadonlyArray<MonitoredPathBaseline>;
}

export function snapshotMonitoredPaths(paths: ReadonlyArray<string>): MonitoredPathBaseline[] {
  return paths.map(snapshotOne);
}

export function assertMonitoredPathsUnchanged(opts: AssertMonitoredPathsOpts): void {
  const leaks = detectLeaks(opts.before, opts.after);
  if (leaks.length > 0) {
    throw new TestableTerminalError(
      ErrorCode.ASSERT_OUTSIDE_LEAK,
      `${leaks.length} monitored path(s) changed during command — first: ${leaks[0]!.path} (${leaks[0]!.op})`,
      { leaks, hint: "installer should write only inside the sandbox; if the path is benign, add to allowed list" },
    );
  }
}

// ─── internals ──────────────────────────────────────────────────────────────

function snapshotOne(p: string): MonitoredPathBaseline {
  if (!fs.existsSync(p)) {
    return { path: p, kind: "absent", sha256: null, dirHash: null, size: null, mtimeMs: null };
  }
  const stat = fs.statSync(p);
  if (stat.isDirectory()) {
    return {
      path: p,
      kind: "dir",
      sha256: null,
      dirHash: hashDir(p),
      size: null,
      mtimeMs: stat.mtimeMs,
    };
  }
  if (stat.isFile()) {
    const buf = fs.readFileSync(p);
    return {
      path: p,
      kind: "file",
      sha256: crypto.createHash("sha256").update(buf).digest("hex"),
      dirHash: null,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    };
  }
  // Special files (sockets, devices) — treat as absent for our purposes.
  return { path: p, kind: "absent", sha256: null, dirHash: null, size: null, mtimeMs: null };
}

/** Hash {name + size + mtimeMs} of all immediate children (sorted by name). */
function hashDir(dir: string): string {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return "READ_FAILED"; }
  const lines = entries
    .map((d) => {
      let size = -1, mtimeMs = -1;
      try {
        const s = fs.statSync(path.join(dir, d.name));
        size = s.size; mtimeMs = s.mtimeMs;
      } catch { /* ignore */ }
      return `${d.name}\t${size}\t${mtimeMs}`;
    })
    .sort()
    .join("\n");
  return crypto.createHash("sha256").update(lines).digest("hex");
}

function detectLeaks(
  before: ReadonlyArray<MonitoredPathBaseline>,
  after: ReadonlyArray<MonitoredPathBaseline>,
): MonitoredPathLeak[] {
  const byPath = new Map<string, MonitoredPathBaseline>();
  for (const b of before) byPath.set(b.path, b);

  const out: MonitoredPathLeak[] = [];
  for (const a of after) {
    const b = byPath.get(a.path);
    if (!b) {
      // Shouldn't happen unless caller passed mismatched lists; treat as add.
      if (a.kind !== "absent") out.push({ path: a.path, op: "added" });
      continue;
    }
    if (b.kind === "absent" && a.kind !== "absent") {
      out.push({ path: a.path, op: "added" });
      continue;
    }
    if (b.kind !== "absent" && a.kind === "absent") {
      out.push({ path: a.path, op: "removed" });
      continue;
    }
    if (b.kind === "file" && a.kind === "file" && b.sha256 !== a.sha256) {
      out.push({
        path: a.path,
        op: "modified",
        snippet: `sha256 changed: ${shortHash(b.sha256)} → ${shortHash(a.sha256)}`,
      });
      continue;
    }
    if (b.kind === "dir" && a.kind === "dir" && b.dirHash !== a.dirHash) {
      out.push({ path: a.path, op: "modified", snippet: "directory contents changed" });
      continue;
    }
    if (b.kind !== a.kind) {
      // file → dir or similar; flag as modified.
      out.push({ path: a.path, op: "modified", snippet: `kind changed: ${b.kind} → ${a.kind}` });
    }
  }
  return out;
}

function shortHash(h: string | null): string {
  if (!h) return "(absent)";
  return h.slice(0, 8);
}
