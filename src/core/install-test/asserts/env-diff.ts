/**
 * assert.env_diff — compare two env snapshots, surface unexpected changes.
 *
 * Operations classified:
 *   add      — key absent in `before`, present in `after`
 *   remove   — key present in `before`, absent in `after`
 *   modify   — key present in both, value differs
 *   prepend  — value extends `before` value at the front (common for PATH)
 *   append   — value extends `before` value at the back
 *
 * `prepend` / `append` are a refinement of `modify` — when the new value
 * literally starts/ends with the old value (with a separator), we surface
 * it that way so allowed_changes can match the common
 * "installer prepended its bin dir to PATH" case without a brittle regex.
 *
 * Pure function. Tests drive synthetic snapshots.
 */

import { ErrorCode, TestableTerminalError } from "../../errors.js";
import type { AllowedEnvChange, EnvChange, EnvSnapshot } from "../../types.js";
import { platform as hostPlatform, type PlatformInfo } from "../../platform.js";

export interface AssertEnvDiffOpts {
  before: EnvSnapshot;
  after: EnvSnapshot;
  /** Whitelist; any unmatched change throws E_TT_ASSERT_ENV_DIFF. */
  allowedChanges?: ReadonlyArray<AllowedEnvChange>;
  /** Override platform (used for path-sep aware prepend/append detection). */
  platform?: PlatformInfo;
}

export function assertEnvDiff(opts: AssertEnvDiffOpts): void {
  const platform = opts.platform ?? hostPlatform;
  const changes = computeChanges(opts.before.env, opts.after.env, platform);
  const allowed = opts.allowedChanges ?? [];
  const unexpected = changes.filter((c) => !matchesAllowed(c, allowed));
  if (unexpected.length > 0) {
    throw new TestableTerminalError(
      ErrorCode.ASSERT_ENV_DIFF,
      `${unexpected.length} unexpected env change(s) — first: ${formatChange(unexpected[0]!)}`,
      { unexpected, allChanges: changes },
    );
  }
}

// Exported for tests + idempotent-install reuse.
export function computeChanges(
  before: Record<string, string>,
  after: Record<string, string>,
  platform: PlatformInfo,
): EnvChange[] {
  const changes: EnvChange[] = [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const k of keys) {
    const b = before[k];
    const a = after[k];
    if (b === undefined && a !== undefined) {
      changes.push({ key: k, op: "add", to: a });
    } else if (b !== undefined && a === undefined) {
      changes.push({ key: k, op: "remove", from: b });
    } else if (b !== a && a !== undefined && b !== undefined) {
      const refined = refineModify(k, b, a, platform);
      changes.push(refined);
    }
  }
  return changes;
}

function refineModify(key: string, before: string, after: string, platform: PlatformInfo): EnvChange {
  const sep = isPathLikeKey(key, platform) ? platform.pathSep : null;
  if (after.length <= before.length) {
    return { key, op: "modify", from: before, to: after };
  }

  if (sep) {
    // prepend: after = "<new><sep><before>"  →  after.endsWith(sep + before)
    if (after.endsWith(sep + before)) {
      return { key, op: "prepend", from: before, to: after };
    }
    // append:  after = "<before><sep><new>"  →  after.startsWith(before + sep)
    if (after.startsWith(before + sep)) {
      return { key, op: "append", from: before, to: after };
    }
  }
  // Non-path keys (or PATH-like that didn't include the sep boundary):
  // simple prefix/suffix relationship still useful for whitelist matching.
  if (after.startsWith(before)) return { key, op: "append", from: before, to: after };
  if (after.endsWith(before))   return { key, op: "prepend", from: before, to: after };
  return { key, op: "modify", from: before, to: after };
}

function isPathLikeKey(key: string, platform: PlatformInfo): boolean {
  if (platform.isWindows) return key.toLowerCase() === "path";
  // POSIX has lots of path-like vars but PATH is the canonical one for our
  // refine logic. Manpath / classpath etc. fall back to plain modify.
  return key === "PATH";
}

function matchesAllowed(change: EnvChange, allowed: ReadonlyArray<AllowedEnvChange>): boolean {
  for (const a of allowed) {
    if (a.key !== change.key) continue;
    if (!opMatches(a.op, change.op)) continue;
    if (a.valuePattern !== undefined) {
      const target = change.to ?? change.from ?? "";
      const re = new RegExp(`^${a.valuePattern}$`);
      if (!re.test(target)) continue;
    }
    return true;
  }
  return false;
}

/**
 * Allow `op: modify` to match prepend/append too — callers usually don't
 * care about the refinement when whitelisting, only that the value changed.
 * `prepend` / `append` whitelist entries match strictly.
 */
function opMatches(allowed: EnvChange["op"], actual: EnvChange["op"]): boolean {
  if (allowed === actual) return true;
  if (allowed === "modify" && (actual === "prepend" || actual === "append")) return true;
  return false;
}

function formatChange(c: EnvChange): string {
  switch (c.op) {
    case "add":     return `${c.key} added: ${truncate(c.to ?? "")}`;
    case "remove":  return `${c.key} removed (was: ${truncate(c.from ?? "")})`;
    case "modify":  return `${c.key} modified: ${truncate(c.from ?? "")} → ${truncate(c.to ?? "")}`;
    case "prepend": return `${c.key} prepended (now: ${truncate(c.to ?? "")})`;
    case "append":  return `${c.key} appended (now: ${truncate(c.to ?? "")})`;
  }
}

function truncate(s: string, n = 80): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
