/**
 * 4-layer config chain (precedence low → high):
 *
 *   1. Built-in defaults              (this file, DEFAULT_CONFIG)
 *   2. ~/.testable-terminal-mcp/config.json   (user-level)
 *   3. $TESTABLE_TERMINAL_CONFIG file          (workspace / CI override)
 *   4. TT_* env vars (scalar only)             (per-invocation knob)
 *
 * Caller-side per-call overrides (MCP tool args, YAML step args) layer on
 * top of the resolved config at runtime — they're not part of this chain.
 *
 * The schema is intentionally validated with zod at boundary: malformed
 * config files surface a precise error rather than silently take effect.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { z } from "zod";
import { ErrorCode, TestableTerminalError } from "./errors.js";

// ─── schema ──────────────────────────────────────────────────────────────────

const SecuritySchema = z.object({
  allowedCommands: z.array(z.string()).default([]),
  allowedWorkdirs: z.array(z.string()).default(["/tmp"]),
  passthroughEnvKeys: z.array(z.string()).default([
    "TERM", "LANG", "USER", "SHELL", "COLORTERM", "HOME", "PATH",
    "SystemRoot", "windir",
  ]),
  redactEnvPatterns: z.array(z.string()).default([
    "*KEY*", "*TOKEN*", "*SECRET*", "*PASSWORD*",
    "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "KIMI_API_KEY", "AIKEY_*",
  ]),
  maxConcurrentSessions: z.number().int().positive().default(8),
  maxConcurrentSandboxes: z.number().int().positive().default(16),
  maxSessionDurationMs: z.number().int().positive().default(600_000),
  defaultIdleTimeoutMs: z.number().int().positive().default(30_000),
  maxOutputBytes: z.number().int().positive().default(20_971_520),
});

const SessionSchema = z.object({
  defaultRows: z.number().int().positive().default(40),
  defaultCols: z.number().int().positive().default(120),
  defaultLoginShell: z.boolean().default(true),
  defaultShell: z.string().nullable().default(null),
  defaultDisplay: z.enum(["headless", "open-terminal", "auto"]).default("headless"),
});

const SandboxSchema = z.object({
  rootDir: z.string().nullable().default(null),
  defaultMode: z.enum(["ephemeral", "persistent"]).default("ephemeral"),
  defaultProfile: z.string().default("minimal"),
  isolateTempDefault: z.boolean().default(false),
  envInheritance: z.object({
    mode: z.enum(["whitelist", "all_with_overlay", "none"]).default("all_with_overlay"),
    redactSecrets: z.boolean().default(true),
    denyKeys: z.array(z.string()).default([
      "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "KIMI_API_KEY", "AIKEY_*",
    ]),
    allowCallerSecretEnv: z.boolean().default(true),
    strictDeny: z.boolean().default(false),
  }).default({}),
});

const AikeySchema = z.object({
  makefileDir: z.string().nullable().default(null),
  sandboxCommand: z.string().default("make sandbox"),
  probeOnStartup: z.boolean().default(true),
});

const MultiVersionSchema = z.object({
  cacheDir: z.string().nullable().default(null),
  cacheMaxBytes: z.number().int().positive().default(10_737_418_240),
  cacheEvictPolicy: z.enum(["lru"]).default("lru"),
  downloadSources: z.record(z.unknown()).default({}),
});

const SnapshotSchema = z.object({
  rootDir: z.string().default("tests/__snapshots__"),
  defaultIncludeAnsi: z.boolean().default(false),
  defaultMasks: z.array(z.string()).default(["claude-tui", "kimi-tui", "aikey-cli", "common-time"]),
});

const InstallTestSchema = z.object({
  outsideMonitorPaths: z.array(z.string()).default([
    "/etc/zshrc", "/etc/zprofile", "/etc/bashrc", "/etc/profile",
    "/etc/profile.d", "/usr/local/bin", "/opt/homebrew",
    "%ProgramFiles%/PowerShell", "%SystemRoot%/System32",
  ]),
  envSnapshotMethod: z.enum(["auto", "current-only", "fresh-login-only"]).default("auto"),
  fileHashAlgo: z.enum(["sha256"]).default("sha256"),
});

const ArtifactsSchema = z.object({
  rootDir: z.string().default("./artifacts"),
  autoDumpOnExpectTimeout: z.boolean().default(true),
  autoDumpOnSessionFail: z.boolean().default(true),
});

const ServerSchema = z.object({
  transport: z.enum(["stdio"]).default("stdio"),
});

export const ConfigSchema = z.object({
  server: ServerSchema.default({}),
  security: SecuritySchema.default({}),
  session: SessionSchema.default({}),
  sandbox: SandboxSchema.default({}),
  aikey: AikeySchema.default({}),
  multiVersion: MultiVersionSchema.default({}),
  snapshot: SnapshotSchema.default({}),
  installTest: InstallTestSchema.default({}),
  artifacts: ArtifactsSchema.default({}),
});

export type Config = z.infer<typeof ConfigSchema>;

// ─── built-in defaults ───────────────────────────────────────────────────────

/** Resolved DEFAULT_CONFIG with all defaults filled in (zod parses {} → fully-defaulted). */
export const DEFAULT_CONFIG: Config = ConfigSchema.parse({});

// ─── env var → config patch ──────────────────────────────────────────────────

/**
 * Map TT_* env vars to scalar config overrides.
 * Only simple paths supported (no array/object via env).
 *
 *   TT_LOG_LEVEL=debug                   → handled by logger, not here
 *   TT_DEFAULT_ROWS=50                   → session.defaultRows = 50
 *   TT_DEFAULT_COLS=180                  → session.defaultCols = 180
 *   TT_DEFAULT_DISPLAY=auto              → session.defaultDisplay
 *   TT_AIKEY_MAKEFILE_DIR=/path          → aikey.makefileDir
 *   TT_SANDBOX_ROOT_DIR=/path            → sandbox.rootDir
 *   TT_MAX_CONCURRENT_SESSIONS=16        → security.maxConcurrentSessions
 */
function envToPatch(env: NodeJS.ProcessEnv): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  const setPath = (dotted: string, value: unknown): void => {
    const keys = dotted.split(".");
    let cursor: Record<string, unknown> = patch;
    for (let i = 0; i < keys.length - 1; i++) {
      const k = keys[i]!;
      if (typeof cursor[k] !== "object" || cursor[k] === null) cursor[k] = {};
      cursor = cursor[k] as Record<string, unknown>;
    }
    cursor[keys[keys.length - 1]!] = value;
  };
  const intOf = (v: string): number | undefined => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : undefined;
  };

  if (env.TT_DEFAULT_ROWS) setPath("session.defaultRows", intOf(env.TT_DEFAULT_ROWS));
  if (env.TT_DEFAULT_COLS) setPath("session.defaultCols", intOf(env.TT_DEFAULT_COLS));
  if (env.TT_DEFAULT_DISPLAY) setPath("session.defaultDisplay", env.TT_DEFAULT_DISPLAY);
  if (env.TT_AIKEY_MAKEFILE_DIR) setPath("aikey.makefileDir", env.TT_AIKEY_MAKEFILE_DIR);
  if (env.TT_SANDBOX_ROOT_DIR) setPath("sandbox.rootDir", env.TT_SANDBOX_ROOT_DIR);
  if (env.TT_MAX_CONCURRENT_SESSIONS) setPath("security.maxConcurrentSessions", intOf(env.TT_MAX_CONCURRENT_SESSIONS));

  return patch;
}

// ─── deep merge (right overrides left) ───────────────────────────────────────

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function deepMerge<T extends Record<string, unknown>>(a: T, b: Partial<T>): T {
  const out: Record<string, unknown> = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (v === undefined) continue;
    const prev = out[k];
    if (isPlainObject(prev) && isPlainObject(v)) {
      out[k] = deepMerge(prev as Record<string, unknown>, v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out as T;
}

// ─── public API ──────────────────────────────────────────────────────────────

export interface LoadConfigOptions {
  /** Override `~/.testable-terminal-mcp/config.json` path. */
  userConfigPath?: string | null;
  /** Override `$TESTABLE_TERMINAL_CONFIG` value (or set null to skip). */
  workspaceConfigPath?: string | null;
  /** Override env vars (test-only). */
  env?: NodeJS.ProcessEnv;
  /** Per-call overrides applied last (e.g. CLI flags). */
  overrides?: Partial<Config>;
}

/**
 * Resolve the full Config by walking the 4-layer chain.
 * Each file is parsed via zod; if any layer fails validation, throw
 * `E_TT_CONFIG_INVALID` with the offending file path + zod issues.
 */
export function loadConfig(opts: LoadConfigOptions = {}): Config {
  const env = opts.env ?? process.env;
  const userPath = opts.userConfigPath !== undefined
    ? opts.userConfigPath
    : path.join(os.homedir(), ".testable-terminal-mcp", "config.json");
  const workspacePath = opts.workspaceConfigPath !== undefined
    ? opts.workspaceConfigPath
    : env.TESTABLE_TERMINAL_CONFIG ?? null;

  // Layer 1: defaults (already a fully-resolved Config).
  let merged: Record<string, unknown> = DEFAULT_CONFIG as unknown as Record<string, unknown>;

  // Layer 2: ~/.testable-terminal-mcp/config.json
  if (userPath) {
    const patch = readJsonIfExists(userPath);
    if (patch) merged = deepMerge(merged, patch);
  }

  // Layer 3: $TESTABLE_TERMINAL_CONFIG
  if (workspacePath) {
    const patch = readJsonIfExists(workspacePath);
    if (patch) merged = deepMerge(merged, patch);
  }

  // Layer 4: TT_* env vars
  const envPatch = envToPatch(env);
  if (Object.keys(envPatch).length > 0) merged = deepMerge(merged, envPatch);

  // Per-call overrides last.
  if (opts.overrides) merged = deepMerge(merged, opts.overrides as Record<string, unknown>);

  // Validate via zod (catches typos in config files).
  const parsed = ConfigSchema.safeParse(merged);
  if (!parsed.success) {
    throw new TestableTerminalError(
      ErrorCode.CONFIG_INVALID,
      `config validation failed: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`,
      { issues: parsed.error.issues },
    );
  }
  return parsed.data;
}

function readJsonIfExists(filePath: string): Record<string, unknown> | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (!isPlainObject(parsed)) {
      throw new TestableTerminalError(
        ErrorCode.CONFIG_INVALID,
        `config file ${filePath} must be a JSON object at top level`,
        { filePath },
      );
    }
    return parsed;
  } catch (err) {
    if (err instanceof TestableTerminalError) throw err;
    if (err instanceof SyntaxError) {
      throw new TestableTerminalError(
        ErrorCode.CONFIG_INVALID,
        `config file ${filePath} is not valid JSON: ${err.message}`,
        { filePath },
      );
    }
    throw err;
  }
}
