/**
 * env-snapshot — capture the env at a point, two modes:
 *
 *   "current"     — the current session's child shell env (via PTY +
 *                   sentinel + Node JSON dump). Reflects what the running
 *                   process sees; misses rc-file writes that only take
 *                   effect on next login.
 *   "fresh-login" — spawn a NEW $SHELL -ilc + Node, capture its env. This
 *                   is what a user would see if they opened a new terminal.
 *                   The install-test default — necessary because installers
 *                   commonly write only to ~/.zshrc, which doesn't affect
 *                   the current session.
 *
 * Round 8 fix: both modes use Node as the JSON encoder
 * (`<host-node> -e "process.stdout.write(JSON.stringify(process.env))"`).
 * Avoids BSD-vs-GNU `env -0 / sort -z` flag differences and round-trips
 * special characters in env values cleanly.
 *
 * Round-7 acceptance: write a fixture that only touches ~/.zshrc; "current"
 * mode misses the change (false pass), "fresh-login" mode catches it. This
 * is why fresh-login is the default for install-test.
 */

import { spawnSync } from "node:child_process";
import { ErrorCode, TestableTerminalError } from "../errors.js";
import { buildSandboxEnv } from "../sandbox/env-injector.js";
import { platform as hostPlatform, type PlatformInfo } from "../platform.js";
import type { EnvInheritanceConfig, EnvSnapshot, EnvSnapshotMode, SandboxRef } from "../types.js";

// ─── public API ─────────────────────────────────────────────────────────────

export interface CaptureOptions {
  name: string;
  mode: EnvSnapshotMode;
  /** Sandbox the snapshot represents. Required for fresh-login (drives HOME). */
  sandbox: SandboxRef;
  /** Path to host Node binary used as JSON encoder. Default: process.execPath. */
  hostNodePath?: string;
  /** Override $SHELL for fresh-login (e.g. force "bash" / "zsh"). */
  shellPath?: string;
  /** When mode=current, this is the running session whose env we want. */
  currentSessionEnv?: Record<string, string>;
  /** Override clock for testing. */
  now?: () => Date;
  /** Override platform branch (test-only). */
  platform?: PlatformInfo;
  /** Inheritance config for env-injector when mode=fresh-login. */
  envInheritance?: EnvInheritanceConfig;
  /** Whitelist for envInheritance.mode=whitelist. */
  passthroughEnvKeys?: ReadonlyArray<string>;
  /** Caller-provided env to pass through (for fresh-login spawn). */
  callerEnv?: Record<string, string>;
  /** Process-level host env (default = process.env). Test-only override. */
  hostEnv?: Record<string, string>;
  /** Subprocess timeout in ms. Default 10s. */
  timeoutMs?: number;
}

export function captureEnvSnapshot(opts: CaptureOptions): EnvSnapshot {
  const now = opts.now ?? (() => new Date());
  switch (opts.mode) {
    case "fresh-login":
      return captureFreshLogin(opts, now);
    case "current":
      return captureCurrent(opts, now);
  }
}

// ─── fresh-login ────────────────────────────────────────────────────────────

const DEFAULT_INHERITANCE: EnvInheritanceConfig = {
  mode: "all_with_overlay",
  denyKeys: [
    "*KEY*", "*TOKEN*", "*SECRET*", "*PASSWORD*",
    "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "KIMI_API_KEY", "AIKEY_*",
  ],
  allowCallerSecretEnv: true,
  strictDeny: false,
};

const DEFAULT_PASSTHROUGH: ReadonlyArray<string> = [
  "TERM", "LANG", "LC_ALL", "LC_CTYPE", "USER", "SHELL", "COLORTERM", "PATH",
];

function captureFreshLogin(opts: CaptureOptions, now: () => Date): EnvSnapshot {
  const platform = opts.platform ?? hostPlatform;
  const hostNode = opts.hostNodePath ?? process.execPath;
  const hostEnv = opts.hostEnv ?? toStringEnv(process.env);

  // The child shell needs to invoke our host Node binary. Build a sandbox
  // env using the same env-injector path as session spawn — the snapshot
  // should reflect what a real session sees, not some separate slimmed env.
  const inheritance = opts.envInheritance ?? DEFAULT_INHERITANCE;
  const passthrough = opts.passthroughEnvKeys ?? DEFAULT_PASSTHROUGH;
  const built = buildSandboxEnv(opts.sandbox, hostEnv, {
    envInheritance: inheritance,
    passthroughEnvKeys: passthrough,
    isolateTemp: false,
    callerEnv: opts.callerEnv,
    platform,
  });

  const cmd = buildFreshLoginCommand({
    shellPath: opts.shellPath ?? built.env.SHELL ?? defaultShell(platform),
    hostNode,
    platform,
  });

  const r = spawnSync(cmd.command, cmd.args, {
    env: built.env,
    cwd: opts.sandbox.path,
    encoding: "utf8",
    timeout: opts.timeoutMs ?? 10_000,
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (r.error || r.status !== 0) {
    throw new TestableTerminalError(
      ErrorCode.FRESH_LOGIN_FAILED,
      `fresh-login env capture failed: status=${r.status} signal=${r.signal} err=${r.error?.message ?? "(none)"}`,
      {
        hint: "check that $SHELL exists and host node binary is executable",
        shellPath: opts.shellPath,
        hostNode,
        stderr: (r.stderr ?? "").slice(0, 2048),
        stdoutHead: (r.stdout ?? "").slice(0, 256),
      },
    );
  }

  const env = parseJsonStdout(r.stdout, opts.name);
  return { name: opts.name, mode: "fresh-login", env, capturedAt: now().toISOString() };
}

interface FreshLoginCommand { command: string; args: string[] }

function buildFreshLoginCommand(opts: {
  shellPath: string;
  hostNode: string;
  platform: PlatformInfo;
}): FreshLoginCommand {
  const inner = `${quote(opts.hostNode)} -e ${quote('process.stdout.write(JSON.stringify(process.env))')}`;
  if (opts.platform.isWindows) {
    return {
      command: opts.shellPath,
      args: ["-NoLogo", "-Command", inner],
    };
  }
  return {
    command: opts.shellPath,
    args: ["-ilc", inner],
  };
}

/** Single-quote for POSIX shells; double-quote for pwsh. Both shells share */
/** this same quoting for the simple paths we generate (no embedded quotes). */
function quote(s: string): string {
  // POSIX shells accept single-quoted strings unchanged except `'` itself.
  // Our inputs (process.execPath + a fixed JSON dump expression) never
  // contain `'`, so this simple form is sufficient. Defensive escape anyway.
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function defaultShell(platform: PlatformInfo): string {
  if (platform.isWindows) return "pwsh";
  return process.env.SHELL ?? "/bin/zsh";
}

// ─── current ────────────────────────────────────────────────────────────────

/**
 * Mode "current" capture: caller passes the running session's child env
 * directly (Session has it via this.proc env at spawn time + any in-shell
 * exports we'd need to track). Implementing PTY + sentinel injection is
 * doable but requires teardown to be reliable; for V1 we take the env
 * snapshot from the spawn-time env. This matches "the running process's
 * view" exactly when the session hasn't done in-shell `export`; when it
 * has, the install-test default of fresh-login is what callers want anyway.
 *
 * Tests + integration drive this with `currentSessionEnv` directly.
 */
function captureCurrent(opts: CaptureOptions, now: () => Date): EnvSnapshot {
  if (!opts.currentSessionEnv) {
    throw new TestableTerminalError(
      ErrorCode.INVALID_INPUT,
      "captureEnvSnapshot mode=current requires currentSessionEnv",
      { hint: "Session.envSnapshot supplies this; direct callers must pass the session's spawn env" },
    );
  }
  return {
    name: opts.name,
    mode: "current",
    env: { ...opts.currentSessionEnv },
    capturedAt: now().toISOString(),
  };
}

// ─── helpers ────────────────────────────────────────────────────────────────

function parseJsonStdout(stdout: string, name: string): Record<string, string> {
  // pwsh / shells may inject blank lines around the JSON. Trim + try the
  // last `{`-prefixed token if pure-JSON parse fails.
  const trimmed = stdout.trim();
  try {
    const parsed = JSON.parse(trimmed);
    return coerceStringMap(parsed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        const parsed = JSON.parse(trimmed.slice(start, end + 1));
        return coerceStringMap(parsed);
      } catch (err) {
        throw new TestableTerminalError(
          ErrorCode.FRESH_LOGIN_FAILED,
          `fresh-login env JSON parse failed for snapshot "${name}": ${(err as Error).message}`,
          { stdoutHead: trimmed.slice(0, 256) },
        );
      }
    }
    throw new TestableTerminalError(
      ErrorCode.FRESH_LOGIN_FAILED,
      `fresh-login env capture produced no JSON payload for snapshot "${name}"`,
      { stdoutHead: trimmed.slice(0, 256) },
    );
  }
}

function coerceStringMap(v: unknown): Record<string, string> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new TestableTerminalError(ErrorCode.FRESH_LOGIN_FAILED, "env JSON was not an object");
  }
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === "string") out[k] = val;
  }
  return out;
}

function toStringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}
