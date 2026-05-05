/**
 * YAML test-case schema (zod) — validates `.yaml` cases the runner accepts.
 *
 * Shape:
 *   name: <string>                            # case name (used in artifact dump)
 *   session:                                  # SessionConfig + sandbox
 *     command: <string>
 *     args: [...]
 *     rows: <int>
 *     cols: <int>
 *     cwd: <string>
 *     login_shell: <bool>
 *     env: { K: V, ... }
 *     sandbox: <"ephemeral" | "persistent">   # creates sandbox at session start
 *     sandbox_profile: <"minimal" | "host-zshrc">
 *     env_inheritance: <"whitelist" | "all_with_overlay" | "none">
 *   steps:
 *     - <step>
 *
 * Steps are tagged unions: each step is an object with exactly one of the
 * keys below + its options.
 *
 *   - write: <string>
 *   - send_key: <"enter" | "tab" | "ctrl_c" | ...>
 *   - resize: { rows: int, cols: int }
 *   - sleep_ms: <int>                         # rare; idle/expect preferred
 *   - expect_text: { text: string, timeout_ms?: int }
 *   - expect_regex: { pattern: string, flags?: string, timeout_ms?: int }
 *   - expect_idle: { idle_ms?: int, max_wait_ms?: int }
 *   - expect_change: { max_wait_ms?: int }
 *   - wait_exit: { max_wait_ms?: int }
 *   - snapshot: { name: string, masks?: string[], inline_masks?: [...], include_ansi?: bool }
 *   - env_snapshot: { name: string, mode?: "current" | "fresh-login" }
 *   - assert_env_no_path_duplicates: { snapshot: string }
 *   - assert_env_diff: { before: string, after: string, allowed_changes?: [...] }
 *   - assert_file_unchanged: { path: string, baseline_id?: string }
 *   - dump_artifacts: { dir?: string, include_ansi_snapshot?: bool }
 *   - close: {}                                # optional; runner auto-closes on exit
 */

import { z } from "zod";

// ─── session ────────────────────────────────────────────────────────────────

export const SessionSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  rows: z.number().int().positive().default(40),
  cols: z.number().int().positive().default(120),
  cwd: z.string().optional(),
  login_shell: z.boolean().default(false),
  /** Files sourced by the wrap shell before exec (aikey active.env, etc). */
  pre_source_files: z.array(z.string()).default([]),
  /** Trigger zsh precmd_functions / bash PROMPT_COMMAND before exec. */
  simulate_precmd_hooks: z.boolean().default(false),
  env: z.record(z.string(), z.string()).default({}),
  // sandbox shorthand: when present, runner creates a sandbox of this mode.
  sandbox: z.enum(["ephemeral", "persistent"]).optional(),
  sandbox_profile: z.enum(["minimal", "host-zshrc"]).default("minimal"),
  sandbox_path: z.string().optional(), // required when sandbox=persistent
  env_inheritance: z.enum(["whitelist", "all_with_overlay", "none"]).optional(),
  isolate_temp: z.boolean().default(false),
}).strict();

export type YamlSessionConfig = z.infer<typeof SessionSchema>;

// ─── step variants ──────────────────────────────────────────────────────────

const expectTextOpts = z.object({
  text: z.string().min(1),
  timeout_ms: z.number().int().positive().default(5_000),
}).strict();

const expectRegexOpts = z.object({
  pattern: z.string().min(1),
  flags: z.string().default(""),
  timeout_ms: z.number().int().positive().default(5_000),
}).strict();

const expectIdleOpts = z.object({
  idle_ms: z.number().int().positive().default(500),
  max_wait_ms: z.number().int().positive().default(5_000),
  require_first_event: z.boolean().default(false),
}).strict();

const waitExitOpts = z.object({
  max_wait_ms: z.number().int().positive().default(5_000),
}).strict();

const snapshotStepOpts = z.object({
  name: z.string().min(1),
  masks: z.array(z.string()).default([]),
  inline_masks: z.array(z.object({
    pattern: z.string(), replace: z.string(), flags: z.string().optional(),
  })).default([]),
  include_ansi: z.boolean().default(false),
}).strict();

const envSnapshotOpts = z.object({
  name: z.string().min(1),
  mode: z.enum(["current", "fresh-login"]).default("fresh-login"),
}).strict();

const assertEnvDiffOpts = z.object({
  before: z.string().min(1),
  after: z.string().min(1),
  allowed_changes: z.array(z.object({
    key: z.string(),
    op: z.enum(["add", "remove", "modify", "prepend", "append"]),
    value_pattern: z.string().optional(),
  })).default([]),
}).strict();

const assertFileUnchangedOpts = z.object({
  path: z.string().min(1),
  baseline_id: z.string().optional(),
}).strict();

const assertNoPathDupsOpts = z.object({
  snapshot: z.string().min(1),
}).strict();

const dumpArtifactsOpts = z.object({
  dir: z.string().optional(),
  include_ansi_snapshot: z.boolean().default(false),
}).strict();

const resizeOpts = z.object({
  rows: z.number().int().positive(),
  cols: z.number().int().positive(),
}).strict();

const sendKeyOpts = z.enum([
  "enter", "tab", "esc", "backspace",
  "ctrl_c", "ctrl_d", "ctrl_l",
  "arrow_up", "arrow_down", "arrow_left", "arrow_right",
]);

// Step union — each step is `{ <op-name>: <op-payload> }`. Exactly ONE key.
export const StepSchema = z.union([
  z.object({ write: z.string() }).strict(),
  z.object({ send_key: sendKeyOpts }).strict(),
  z.object({ resize: resizeOpts }).strict(),
  z.object({ sleep_ms: z.number().int().nonnegative() }).strict(),
  z.object({ expect_text: expectTextOpts }).strict(),
  z.object({ expect_regex: expectRegexOpts }).strict(),
  z.object({ expect_idle: expectIdleOpts }).strict(),
  z.object({ expect_change: z.object({ max_wait_ms: z.number().int().positive().default(5_000) }).strict() }).strict(),
  z.object({ wait_exit: waitExitOpts }).strict(),
  z.object({ snapshot: snapshotStepOpts }).strict(),
  z.object({ env_snapshot: envSnapshotOpts }).strict(),
  z.object({ assert_env_no_path_duplicates: assertNoPathDupsOpts }).strict(),
  z.object({ assert_env_diff: assertEnvDiffOpts }).strict(),
  z.object({ assert_file_unchanged: assertFileUnchangedOpts }).strict(),
  z.object({ dump_artifacts: dumpArtifactsOpts }).strict(),
  z.object({ close: z.object({}).strict() }).strict(),
]);

export type YamlStep = z.infer<typeof StepSchema>;

// ─── case (top level) ───────────────────────────────────────────────────────

export const CaseSchema = z.object({
  name: z.string().min(1),
  session: SessionSchema,
  steps: z.array(StepSchema).min(1),
  // Where to put artifacts on failure. Defaults to ./artifacts/<case-slug>/.
  artifacts_dir: z.string().optional(),
  // Snapshot store root (M7).
  snapshot_root_dir: z.string().default("tests/__snapshots__"),
}).strict();

export type YamlCase = z.infer<typeof CaseSchema>;
