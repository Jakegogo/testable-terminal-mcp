/**
 * env-injector — build the env that a sandbox session's child process sees.
 *
 * Pure function from (sandbox, hostEnv, opts) → env. No fs, no process state.
 * Tests drive it with synthetic inputs.
 *
 * Three layers (round 2 R2-1, round 7 caller-env split, technical spec §11.2):
 *
 *   1. Host env per inheritance mode:
 *        whitelist          — only keys in passthroughEnvKeys
 *        all_with_overlay   — copy all host env (default)
 *        none               — start empty
 *   2. denyKeys filter (glob, case-insensitive). Always applied to
 *      host-derived env, never bypassable.
 *   3. Virtual HOME injection — overrides host:
 *        HOME / USERPROFILE / HOMEDRIVE / HOMEPATH
 *      PATH rewritten to prepend sandbox bin dirs.
 *      isolateTemp=true → TMPDIR/TEMP/TMP point inside sandbox.
 *   4. Caller-provided env (last writer wins). Round-7 two-layer:
 *      allowCallerSecretEnv=true (default) means the spawn DOES see secret-
 *      shape keys (artifact redaction happens elsewhere). =false enforces
 *      denyKeys against caller env too.
 */

import { ErrorCode, TestableTerminalError } from "../errors.js";
import { shouldRedact } from "../security.js";
import type { PlatformInfo } from "../platform.js";
import type { EnvInheritanceConfig, SandboxRef } from "../types.js";

// ─── public types ────────────────────────────────────────────────────────────

export interface BuildSandboxEnvOpts {
  /** Inheritance mode + denyKeys + caller-secret policy. */
  envInheritance: EnvInheritanceConfig;
  /** Whitelist used when envInheritance.mode === "whitelist". */
  passthroughEnvKeys: ReadonlyArray<string>;
  /** When true, point TMPDIR/TEMP/TMP into sandbox/tmp. */
  isolateTemp: boolean;
  /** Caller-provided env (e.g. { ANTHROPIC_API_KEY: "sk-..." }). Last layer. */
  callerEnv?: Record<string, string>;
  /** Platform branch (Windows needs USERPROFILE/HOMEDRIVE/HOMEPATH/Path). */
  platform: PlatformInfo;
}

export interface BuildSandboxEnvResult {
  /** Final env to pass to pty.spawn. */
  env: Record<string, string>;
  /** Diagnostic: keys removed by denyKeys (host inheritance only). */
  denied: ReadonlyArray<string>;
  /** Diagnostic: keys passed through from host (after deny filtering). */
  hostInherited: ReadonlyArray<string>;
}

// ─── main ────────────────────────────────────────────────────────────────────

export function buildSandboxEnv(
  sandbox: SandboxRef,
  hostEnv: Record<string, string>,
  opts: BuildSandboxEnvOpts,
): BuildSandboxEnvResult {
  const { envInheritance, passthroughEnvKeys, isolateTemp, callerEnv, platform } = opts;

  // ── 1. host env per inheritance mode ────────────────────────────────────
  let host: Record<string, string> = {};
  switch (envInheritance.mode) {
    case "whitelist": {
      for (const k of passthroughEnvKeys) {
        const v = hostEnv[k];
        if (typeof v === "string") host[k] = v;
      }
      break;
    }
    case "all_with_overlay": {
      host = { ...hostEnv };
      break;
    }
    case "none": {
      host = {};
      break;
    }
  }

  // ── 2. deny-keys filter (host-only) ─────────────────────────────────────
  const denied: string[] = [];
  for (const k of Object.keys(host)) {
    if (shouldRedact(k, envInheritance.denyKeys)) {
      delete host[k];
      denied.push(k);
    }
  }
  const hostInherited = Object.keys(host).slice();

  // ── 3. virtual HOME injection (always overrides host) ───────────────────
  const env: Record<string, string> = { ...host };
  injectVirtualHome(env, sandbox.path, platform);

  // ── 4. PATH composition ─────────────────────────────────────────────────
  // Use the *target* platform's separator, not the host's. This matters for
  // testing Windows env on a macOS host (or vice versa); using node:path
  // would always yield the host sep.
  const join = (...parts: string[]): string => parts.join(platform.fsSep);
  const sandboxBins = [
    join(sandbox.path, "bin"),
    join(sandbox.path, ".local", "bin"),
    join(sandbox.path, ".aikey", "bin"),
  ];
  const hostPath = pickHostPath(hostEnv, platform, envInheritance.mode);
  env.PATH = composeUniquePath([...sandboxBins, ...hostPath], platform);
  if (platform.isWindows) {
    // cmd.exe reads `Path`; pwsh reads either. Mirror so both see the same.
    env.Path = env.PATH;
  }

  // ── 5. isolateTemp ──────────────────────────────────────────────────────
  if (isolateTemp) {
    const tmp = join(sandbox.path, "tmp");
    env.TMPDIR = tmp;
    env.TEMP = tmp;
    env.TMP = tmp;
  }

  // ── 6. caller-provided env (last) ───────────────────────────────────────
  if (callerEnv) {
    for (const [k, v] of Object.entries(callerEnv)) {
      if (!envInheritance.allowCallerSecretEnv && shouldRedact(k, envInheritance.denyKeys)) {
        if (envInheritance.strictDeny) {
          throw new TestableTerminalError(
            ErrorCode.ENV_KEY_NOT_ALLOWED,
            `caller-provided env key "${k}" matches denyKeys; allowCallerSecretEnv=false strictDeny=true rejects it`,
            { hint: "set allowCallerSecretEnv=true to allow caller secrets (real-agent test mode)", key: k },
          );
        }
        // strictDeny=false: silently drop.
        continue;
      }
      env[k] = v;
    }
  }

  return { env, denied, hostInherited };
}

// ─── helpers ────────────────────────────────────────────────────────────────

function injectVirtualHome(env: Record<string, string>, sandboxPath: string, platform: PlatformInfo): void {
  // POSIX: HOME is canonical.
  env.HOME = sandboxPath;
  if (platform.isWindows) {
    // Windows: USERPROFILE is canonical for most user-space tools (incl. pwsh).
    // HOMEDRIVE + HOMEPATH split is preserved for legacy cmd / batch scripts.
    env.USERPROFILE = sandboxPath;
    const { drive, sub } = splitDrivePath(sandboxPath);
    env.HOMEDRIVE = drive;
    env.HOMEPATH = sub;
  }
}

/** Split "C:\\Users\\x" → { drive: "C:", sub: "\\Users\\x" }. Drive falls back to "" on weird input. */
function splitDrivePath(p: string): { drive: string; sub: string } {
  const m = /^([A-Za-z]:)(.*)$/.exec(p);
  if (!m) return { drive: "", sub: p };
  return { drive: m[1]!, sub: m[2] ?? "" };
}

/** Pull host PATH respecting platform sep + the inheritance mode's gate. */
function pickHostPath(
  hostEnv: Record<string, string>,
  platform: PlatformInfo,
  mode: EnvInheritanceConfig["mode"],
): string[] {
  if (mode === "none") return [];
  // Windows: env keys are case-insensitive; node-pty preserves casing as
  // received. We probe both spellings.
  const raw = platform.isWindows
    ? (hostEnv.Path ?? hostEnv.PATH ?? "")
    : (hostEnv.PATH ?? "");
  if (!raw) return [];
  return raw.split(platform.pathSep).filter((s) => s.length > 0);
}

/** Compose a PATH string preserving order, dropping duplicates by exact-string match. */
function composeUniquePath(parts: ReadonlyArray<string>, platform: PlatformInfo): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of parts) {
    if (p.length === 0) continue;
    // On Windows compare case-insensitive (path comparisons are CI there).
    const key = platform.isWindows ? p.toLowerCase() : p;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out.join(platform.pathSep);
}
