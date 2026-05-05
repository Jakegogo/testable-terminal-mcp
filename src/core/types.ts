/**
 * Shared types for core/. Schemas / runtime validators live in their own
 * modules (config.ts has zod schemas; adapters/ schemas are zod too) — this
 * file is types-only, no runtime code.
 */

// ─── Session lifecycle ──────────────────────────────────────────────────────

export type TerminalSessionStatus =
  | "created"
  | "starting"
  | "running"
  | "exited"
  | "killed"
  | "timeout"
  | "failed";

// ─── Keys ────────────────────────────────────────────────────────────────────

export type TerminalKey =
  | "enter" | "tab" | "esc" | "backspace"
  | "ctrl_c" | "ctrl_d" | "ctrl_l"
  | "arrow_up" | "arrow_down" | "arrow_left" | "arrow_right";

// ─── Snapshot ────────────────────────────────────────────────────────────────

/**
 * Range strategy for `Session.snapshot({ range })`.
 *   "viewport"             — only visible rows × cols (TUI default)
 *   "all"                  — full buffer including scrollback
 *   { lastLines: N }       — last N rows from buffer bottom
 *
 * Default at Session.snapshot(): { lastLines: 200 }.
 */
export type SnapshotRange = "viewport" | "all" | { lastLines: number };

export interface ResolvedRange {
  kind: "viewport" | "all" | "lastLines";
  startRow: number;
  endRow: number;     // exclusive
  totalBufferRows: number;
}

export interface ScreenRead {
  plainLines: string[];
  ansiLines: string[];
  plainText: string;
  ansiText: string;
  cursor: { row: number; col: number };
  range: ResolvedRange;
}

export interface TerminalSnapshot {
  session_id: string;
  rows: number;
  cols: number;
  status: TerminalSessionStatus;
  text: string;
  lines: string[];
  ansi_text?: string;
  ansi_lines?: string[];
  cursor: { row: number; col: number };
  content_hash: string;
  timestamp: string;
  raw_tail?: string;
  raw_truncated: boolean;
  range: ResolvedRange;
}

// ─── Events ──────────────────────────────────────────────────────────────────

export type TerminalEventType =
  | "session.created" | "session.started"
  | "input.write" | "input.key"
  | "output.data"
  | "screen.dirty" | "screen.snapshot"
  | "expect.match" | "expect.timeout"
  | "resize"
  | "process.exit"
  | "session.closed" | "session.killed"
  | "error";

export interface TerminalEvent {
  type: TerminalEventType;
  ts: string;
  session_id: string;
  data?: unknown;
}

// ─── Display / live preview ──────────────────────────────────────────────────

export type DisplayMode = "headless" | "open-terminal" | "auto";
export type ResolvedDisplayMode = "headless" | "open-terminal";

// ─── History API ─────────────────────────────────────────────────────────────

export interface HistoryStats {
  bytes: number;
  chunks: number;
  truncated: boolean;
  /** non-null only when caller set historyLogPath (or display=open-terminal auto-created one). */
  path: string | null;
}

// ─── Sandbox (M4) ────────────────────────────────────────────────────────────

export type SandboxMode = "ephemeral" | "persistent";

/**
 * env inheritance from host into sandbox session (round 2 R2-1).
 *   - whitelist:           only keys in passthroughEnvKeys come through
 *   - all_with_overlay:    inherit all host env, sandbox/caller overlays override (default)
 *   - none:                no host env at all (PATH still gets sandbox bins)
 *
 * `denyKeys` is applied AFTER inheritance, regardless of mode — it's the
 * "anti secret-leak" gate. Caller-provided env is governed by the round-7
 * two-layer policy (see security.filterCallerEnv).
 */
export type EnvInheritanceMode = "whitelist" | "all_with_overlay" | "none";

export interface EnvInheritanceConfig {
  mode: EnvInheritanceMode;
  /** glob-style patterns; matched case-insensitively against env keys. */
  denyKeys: ReadonlyArray<string>;
  /** Round 7: when true, caller-provided env may include secret-shape keys (artifact gets redacted). */
  allowCallerSecretEnv: boolean;
  /** When allowCallerSecretEnv=false, throw on offending caller key (true) or silently drop (false). */
  strictDeny: boolean;
}

export type SandboxProfileName = "minimal" | "host-zshrc";

export interface SandboxSeedConfig {
  /** dst-relative path → file content (UTF-8). Existing seed files overwrite. */
  files?: Record<string, string>;
  /** Host paths to recursively copy into the sandbox (e.g. ["~/.aikey"]). */
  copyFromHost?: ReadonlyArray<string>;
}

export interface SandboxConfig {
  mode: SandboxMode;
  /** Required for mode=persistent. For ephemeral, mkdtemp is used. */
  path?: string;
  /** Built-in template name; defaults to "minimal". */
  profile?: SandboxProfileName;
  seed?: SandboxSeedConfig;
  /** Inject TMPDIR/TEMP/TMP pointing into sandbox/tmp. Default false. */
  isolateTemp?: boolean;
  /** Whitelist for envInheritance.mode=whitelist. Default = config.security.passthroughEnvKeys. */
  passthroughEnvKeys?: ReadonlyArray<string>;
  /** Override the default envInheritance config (sourced from config.sandbox.envInheritance). */
  envInheritance?: Partial<EnvInheritanceConfig>;
}

/**
 * Reference handle returned by `sandboxManager.create`. Sessions reference
 * sandboxes by id; the path is exposed for diagnostics + seed file writes.
 */
export interface SandboxRef {
  id: string;
  path: string;
  mode: SandboxMode;
  profile: SandboxProfileName;
  createdAt: Date;
}

// ─── Install-test toolkit (M6) ──────────────────────────────────────────────

export type EnvSnapshotMode = "current" | "fresh-login";

/**
 * Captured env at a point in time. Stored on the Session in a Map keyed by
 * `name` so subsequent asserts (env_diff, idempotent_install) can reference
 * "before" / "after" snapshots without re-capturing.
 */
export interface EnvSnapshot {
  /** Caller-chosen name (e.g. "before", "after", "before-round2"). */
  name: string;
  /** Mode used to capture; affects whether rc-file writes are visible. */
  mode: EnvSnapshotMode;
  /** Captured env. Keys preserve case as the shell delivered them. */
  env: Record<string, string>;
  /** ISO timestamp. */
  capturedAt: string;
}

export type EnvDiffOp = "add" | "remove" | "modify" | "prepend" | "append";

export interface EnvChange {
  key: string;
  op: EnvDiffOp;
  /** Present for remove / modify. */
  from?: string;
  /** Present for add / modify / prepend / append. */
  to?: string;
}

/** A whitelist entry against which env changes are matched. */
export interface AllowedEnvChange {
  key: string;
  op: EnvDiffOp;
  /** Optional regex (string form, anchored at full value). When omitted, any value passes. */
  valuePattern?: string;
}

/**
 * sha256 of a sandboxed file at a known point. Used by file_unchanged +
 * idempotent_install to detect drift.
 *
 * `content` caches the original bytes (UTF-8) for small text files so
 * `assert.file_unchanged` can produce a real unified diff on failure
 * without re-reading the post-change file. Capped to keep memory bounded.
 */
export interface FileBaseline {
  /** Caller-chosen baseline id (e.g. "session-create", "after-install-1"). */
  id: string;
  /** sandbox-relative or absolute path that was hashed. */
  path: string;
  /** Hex sha256 of the file at capture time. null when the path didn't exist. */
  sha256: string | null;
  /** Size in bytes. null when absent. */
  size: number | null;
  /** Original UTF-8 content; null when file absent OR too large to cache OR binary. */
  content: string | null;
  /** ISO timestamp. */
  capturedAt: string;
}

export type MonitoredPathOp = "added" | "modified" | "removed";

export interface MonitoredPathLeak {
  path: string;
  op: MonitoredPathOp;
  /** Short human-readable summary (e.g. "+12 lines"). */
  snippet?: string;
}
