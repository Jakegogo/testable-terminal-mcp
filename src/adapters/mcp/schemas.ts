/**
 * MCP tool schemas — input shapes for each terminal/sandbox/assert tool.
 *
 * Per technical spec §5: 24 tools total
 *   14 terminal.*  (create_session, write, send_key, snapshot, expect_text,
 *                   expect_regex, expect_idle, expect_change, wait_exit,
 *                   resize, get_env, dump_artifacts, close_session,
 *                   get_history)
 *    3 sandbox.*   (create, destroy, install)
 *    6 assert.*    (snapshot, env_no_path_duplicates, env_diff,
 *                   file_unchanged, idempotent_install,
 *                   monitored_paths_unchanged)
 *    1 terminal.env_snapshot
 *
 * All tools return a result object with:
 *   { ok: true, ... }    success
 *   { ok: false, error_code, message, hint?, snapshot? }
 *
 * For input validation we use plain ZodRawShape (so MCP SDK's `inputSchema`
 * key accepts our shapes). Zod object construction is left to the caller.
 */

import { z } from "zod";

// ─── shared scalars ─────────────────────────────────────────────────────────

const sessionIdField = { session_id: z.string().min(1) };
const sandboxIdField = { sandbox_id: z.string().min(1) };

// ─── terminal.* shapes ──────────────────────────────────────────────────────

export const TerminalCreateSessionShape = {
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  rows: z.number().int().positive().optional(),
  cols: z.number().int().positive().optional(),
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  login_shell: z.boolean().optional(),
  pre_source_files: z.array(z.string()).optional(),
  simulate_precmd_hooks: z.boolean().optional(),
  display: z.enum(["headless", "open-terminal", "auto"]).optional(),
  history_log_path: z.string().optional(),
  viewer_window_title: z.string().optional(),
  sandbox_id: z.string().optional(),
} as const;

export const TerminalWriteShape = {
  ...sessionIdField,
  text: z.string(),
} as const;

export const TerminalSendKeyShape = {
  ...sessionIdField,
  key: z.enum([
    "enter", "tab", "esc", "backspace",
    "ctrl_c", "ctrl_d", "ctrl_l",
    "arrow_up", "arrow_down", "arrow_left", "arrow_right",
  ]),
} as const;

export const TerminalSnapshotShape = {
  ...sessionIdField,
  include_ansi: z.boolean().optional(),
  include_raw_tail: z.boolean().optional(),
  range: z.union([
    z.literal("viewport"),
    z.literal("all"),
    z.object({ last_lines: z.number().int().positive() }).strict(),
  ]).optional(),
} as const;

export const TerminalGetHistoryShape = {
  ...sessionIdField,
  format: z.enum(["raw", "clean", "bytes"]).default("clean"),
  max_bytes: z.number().int().positive().optional(),
} as const;

export const TerminalExpectTextShape = {
  ...sessionIdField,
  text: z.string().min(1),
  timeout_ms: z.number().int().positive().default(5_000),
} as const;

export const TerminalExpectRegexShape = {
  ...sessionIdField,
  pattern: z.string().min(1),
  flags: z.string().default(""),
  timeout_ms: z.number().int().positive().default(5_000),
} as const;

export const TerminalExpectIdleShape = {
  ...sessionIdField,
  idle_ms: z.number().int().positive().default(500),
  max_wait_ms: z.number().int().positive().default(5_000),
} as const;

export const TerminalExpectChangeShape = {
  ...sessionIdField,
  max_wait_ms: z.number().int().positive().default(5_000),
} as const;

export const TerminalWaitExitShape = {
  ...sessionIdField,
  max_wait_ms: z.number().int().positive().default(10_000),
} as const;

export const TerminalResizeShape = {
  ...sessionIdField,
  rows: z.number().int().positive(),
  cols: z.number().int().positive(),
} as const;

export const TerminalGetEnvShape = {
  ...sessionIdField,
  redact: z.boolean().default(true),
} as const;

export const TerminalDumpArtifactsShape = {
  ...sessionIdField,
  dir: z.string().optional(),
  include_ansi_snapshot: z.boolean().default(false),
} as const;

export const TerminalCloseSessionShape = {
  ...sessionIdField,
  kill: z.boolean().default(true),
  graceful_timeout_ms: z.number().int().positive().default(1_500),
} as const;

// ─── sandbox.* ──────────────────────────────────────────────────────────────

export const SandboxCreateShape = {
  mode: z.enum(["ephemeral", "persistent"]),
  path: z.string().optional(),
  profile: z.enum(["minimal", "host-zshrc"]).default("minimal"),
  isolate_temp: z.boolean().default(false),
} as const;

export const SandboxDestroyShape = {
  ...sandboxIdField,
} as const;

export const SandboxInstallShape = {
  ...sandboxIdField,
  tool: z.string().min(1),
  version: z.string().min(1),
  download_sources: z.record(z.string(), z.record(z.string(), z.string())),
  cache_dir: z.string().optional(),
  cache_max_bytes: z.number().int().positive().optional(),
  expected_sha256: z.string().optional(),
} as const;

// ─── assert.* ───────────────────────────────────────────────────────────────

export const AssertSnapshotShape = {
  ...sessionIdField,
  name: z.string().min(1),
  test_file_id: z.string().min(1),
  root_dir: z.string().default("tests/__snapshots__"),
  masks: z.array(z.string()).default([]),
  inline_masks: z.array(z.object({
    pattern: z.string(), replace: z.string(), flags: z.string().optional(),
  })).default([]),
  include_ansi: z.boolean().default(false),
} as const;

export const AssertEnvNoPathDuplicatesShape = {
  ...sessionIdField,
  snapshot_name: z.string().min(1),
} as const;

export const AssertEnvDiffShape = {
  ...sessionIdField,
  before_name: z.string().min(1),
  after_name: z.string().min(1),
  allowed_changes: z.array(z.object({
    key: z.string(),
    op: z.enum(["add", "remove", "modify", "prepend", "append"]),
    value_pattern: z.string().optional(),
  })).default([]),
} as const;

export const AssertFileUnchangedShape = {
  ...sessionIdField,
  path: z.string().min(1),
  baseline_id: z.string().optional(),
} as const;

// idempotent_install needs a runner callback — for MCP we accept a shell
// command string; the server runs it via session.write+wait under the hood.
export const AssertIdempotentInstallShape = {
  ...sessionIdField,
  command: z.string().min(1),
  files_to_compare: z.array(z.string()).min(1),
  /** Tokens that mark command completion (regex). One must appear after each round. */
  completion_pattern: z.string().default("\\$\\s$"),
  per_round_timeout_ms: z.number().int().positive().default(10_000),
} as const;

export const AssertMonitoredPathsUnchangedShape = {
  ...sessionIdField,
  command: z.string().min(1),
  monitor_paths: z.array(z.string()).min(1),
  completion_pattern: z.string().default("\\$\\s$"),
  per_round_timeout_ms: z.number().int().positive().default(10_000),
} as const;

// ─── terminal.env_snapshot ──────────────────────────────────────────────────

export const TerminalEnvSnapshotShape = {
  ...sessionIdField,
  name: z.string().min(1),
  mode: z.enum(["current", "fresh-login"]).default("fresh-login"),
} as const;

// ─── tool catalog (for tools.ts) ────────────────────────────────────────────

export const TOOL_NAMES = [
  "terminal.create_session",
  "terminal.write",
  "terminal.send_key",
  "terminal.snapshot",
  "terminal.get_history",
  "terminal.expect_text",
  "terminal.expect_regex",
  "terminal.expect_idle",
  "terminal.expect_change",
  "terminal.wait_exit",
  "terminal.resize",
  "terminal.get_env",
  "terminal.dump_artifacts",
  "terminal.close_session",
  "terminal.env_snapshot",
  "sandbox.create",
  "sandbox.destroy",
  "sandbox.install",
  "assert.snapshot",
  "assert.env_no_path_duplicates",
  "assert.env_diff",
  "assert.file_unchanged",
  "assert.idempotent_install",
  "assert.monitored_paths_unchanged",
] as const;

export type ToolName = typeof TOOL_NAMES[number];
