/**
 * Security: command/cwd allowlist + env redaction + caller-secret policy.
 *
 * All checks are pure functions of (input, policy) — no global state — so
 * tests can drive them with synthetic policies.
 *
 * Round 7 added the two-layer env model: host-inheritance is strict
 * (denyKeys never bypassable), caller-provided env is opt-in (redacted to
 * artifact but spawned to child unless `allowCallerSecretEnv: false`).
 */

import * as path from "node:path";
import { ErrorCode, TestableTerminalError } from "./errors.js";

// ─── command allowlist ──────────────────────────────────────────────────────

export interface CommandPolicy {
  allowedCommands: ReadonlyArray<string>;
}

/**
 * Verify `command` is on the allow-list. Compares basename only — strips
 * any directory prefix and (on Windows) the .exe / .cmd / .ps1 suffix to
 * avoid `C:\Windows\System32\bash.exe` masquerading as a different binary.
 *
 * Throws E_TT_CMD_NOT_ALLOWED otherwise.
 *
 * Note: if `policy.allowedCommands` is empty, EVERY command is rejected.
 * Callers that genuinely want "any command" must pass an explicit `["*"]`
 * marker (handled below) — there's no implicit "all".
 */
export function assertAllowedCommand(command: string, policy: CommandPolicy): void {
  const base = commandBasename(command);
  // Explicit wildcard escape hatch — only honored if the policy is exactly ["*"].
  if (policy.allowedCommands.length === 1 && policy.allowedCommands[0] === "*") return;
  if (!policy.allowedCommands.some((allow) => commandBasename(allow) === base)) {
    throw new TestableTerminalError(
      ErrorCode.CMD_NOT_ALLOWED,
      `command "${base}" is not in allowedCommands`,
      { hint: `add "${base}" to security.allowedCommands or set ["*"] to allow all (development only)`, command, allowedCommands: policy.allowedCommands },
    );
  }
}

function commandBasename(command: string): string {
  const justName = command.split(/[\\/]/).pop() ?? command;
  return justName.toLowerCase().replace(/\.(exe|cmd|ps1|bat)$/, "");
}

// ─── cwd allowlist ──────────────────────────────────────────────────────────

export interface CwdPolicy {
  allowedWorkdirs: ReadonlyArray<string>;
  /** Treat path comparisons case-insensitive (Windows default). */
  caseInsensitive?: boolean;
}

/**
 * Verify `cwd` is inside one of the allowed workdirs.
 * Does NOT follow symlinks — the resolved path must be a prefix match of
 * an allowed dir's resolved path. `..` traversal is rejected because we
 * `path.resolve` first.
 */
export function assertAllowedCwd(cwd: string, policy: CwdPolicy): void {
  const resolved = path.resolve(cwd);
  const norm = (p: string): string => {
    const r = path.resolve(p);
    return policy.caseInsensitive ? r.toLowerCase() : r;
  };
  const target = norm(resolved);
  for (const allowed of policy.allowedWorkdirs) {
    const allowedResolved = norm(allowed);
    if (target === allowedResolved) return;
    if (target.startsWith(allowedResolved + path.sep)) return;
  }
  throw new TestableTerminalError(
    ErrorCode.CWD_NOT_ALLOWED,
    `cwd "${cwd}" (resolved to "${resolved}") is not under any allowedWorkdirs`,
    { hint: `add a parent directory to security.allowedWorkdirs`, cwd, resolved, allowedWorkdirs: policy.allowedWorkdirs },
  );
}

// ─── env redaction (secret-shape pattern matching) ──────────────────────────

/**
 * Pattern syntax: glob-like with `*` only (case-insensitive).
 *   "*KEY*"             matches any key containing "key"
 *   "ANTHROPIC_API_KEY" exact match (still case-insensitive)
 *   "AIKEY_*"           prefix
 *
 * Empty patterns match nothing (no `redact-everything` accident).
 */
export function shouldRedact(envKey: string, patterns: ReadonlyArray<string>): boolean {
  const upper = envKey.toUpperCase();
  for (const raw of patterns) {
    const pat = raw.toUpperCase();
    if (matchGlob(upper, pat)) return true;
  }
  return false;
}

function matchGlob(input: string, pattern: string): boolean {
  // Convert glob to regex, escaping all regex metas except `*`.
  const re = "^" + pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*") + "$";
  return new RegExp(re).test(input);
}

/** Replace values of secret-shape keys with `***REDACTED***`. Pure. */
export function redactEnv(
  env: Record<string, string>,
  patterns: ReadonlyArray<string>,
  replacement = "***REDACTED***",
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    out[k] = shouldRedact(k, patterns) ? replacement : v;
  }
  return out;
}

// ─── caller-secret env policy (round 7) ─────────────────────────────────────

export interface CallerEnvPolicy {
  /** When false, caller-provided keys matching denyKeys are blocked. Round 7. */
  allowCallerSecretEnv: boolean;
  /** When allowCallerSecretEnv=false, throw on offending keys (true) or silently drop (false). */
  strictDeny: boolean;
  denyKeys: ReadonlyArray<string>;
}

/**
 * Filter caller-provided env per the round-7 two-layer model.
 *
 * Returns the env that's safe to spawn to child. When strictDeny=true and a
 * caller key matches denyKeys, throws E_TT_ENV_KEY_NOT_ALLOWED.
 *
 * Note: this is for caller-provided env only. Host-inheritance redaction
 * happens in env-injector (M4); this function isn't on that path.
 */
export function filterCallerEnv(
  callerEnv: Record<string, string>,
  policy: CallerEnvPolicy,
): Record<string, string> {
  if (policy.allowCallerSecretEnv) {
    // caller can pass anything; spawn-time gets full env. Redaction to artifacts/get_env happens elsewhere.
    return { ...callerEnv };
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(callerEnv)) {
    if (shouldRedact(k, policy.denyKeys)) {
      if (policy.strictDeny) {
        throw new TestableTerminalError(
          ErrorCode.ENV_KEY_NOT_ALLOWED,
          `caller-provided env key "${k}" matches denyKeys; allowCallerSecretEnv=false strictDeny=true rejects it`,
          { hint: "set allowCallerSecretEnv=true if this is real-agent test;or remove the secret-shape key from caller env", key: k },
        );
      }
      // strictDeny=false: silently drop.
      continue;
    }
    out[k] = v;
  }
  return out;
}
