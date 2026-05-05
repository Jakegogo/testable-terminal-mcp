/**
 * MCP tool dispatch — registers each tool on an McpServer instance and
 * marshals MCP call arguments to core API calls.
 *
 * Design notes:
 *   - The MCP SDK is not stable enough to bind directly with `registerTool`
 *     in a way that survives across multiple SDK minor versions. We expose
 *     `registerAllTools(server, registry)` where the server's
 *     `registerTool` method does the work; the dispatch logic lives here so
 *     it's testable WITHOUT an actual McpServer instance.
 *   - Each tool returns either { ok: true, ... } or
 *     { ok: false, error_code, message, hint?, snapshot? }. We never throw
 *     to the SDK boundary — failures get wrapped.
 *   - Sessions + sandboxes are tracked in registries keyed by the id we
 *     return to the client, so subsequent calls can locate them.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { startSession, type Session } from "../../core/terminal-session.js";
import {
  createSandbox, destroySandbox, getSandbox,
} from "../../core/sandbox/manager.js";
import { DownloadCache } from "../../core/download-cache/cache.js";
import { installVersion, type DownloadSourceMap } from "../../core/download-cache/installers.js";
import { assertSnapshot } from "../../core/snapshot-test/index.js";
import { isTestableTerminalError } from "../../core/errors.js";
import * as schemas from "./schemas.js";

// ─── result envelope ─────────────────────────────────────────────────────────

export interface SuccessResult { ok: true; [k: string]: unknown }
export interface ErrorResult {
  ok: false;
  error_code: string;
  message: string;
  hint?: string;
  details?: unknown;
}
export type ToolResult = SuccessResult | ErrorResult;

// ─── registry ────────────────────────────────────────────────────────────────

export class ToolRegistry {
  private readonly sessions = new Map<string, Session>();

  /** Register a session under its id. Tracks for later id-based lookup. */
  registerSession(s: Session): void { this.sessions.set(s.id, s); }
  unregisterSession(id: string): void { this.sessions.delete(id); }
  getSession(id: string): Session | null { return this.sessions.get(id) ?? null; }

  /** Diagnostic snapshot of the live session count. */
  size(): number { return this.sessions.size; }
}

// ─── dispatch table — pure functions that take parsed args + registry ───────

export interface DispatchContext {
  registry: ToolRegistry;
}

/**
 * Each handler is async, takes parsed args and the dispatch context, and
 * returns a ToolResult. The MCP server adapter calls these via the SDK's
 * tool-registration callback (with structured content).
 */
export const HANDLERS: Record<schemas.ToolName, (args: unknown, ctx: DispatchContext) => Promise<ToolResult>> = {
  "terminal.create_session": withParse(schemas.TerminalCreateSessionShape, async (args, ctx) => {
    const sandbox = args.sandbox_id ? getSandbox(args.sandbox_id) ?? undefined : undefined;
    if (args.sandbox_id && !sandbox) return notFound("sandbox", args.sandbox_id);
    const session = await startSession({
      command: args.command,
      args: args.args,
      rows: args.rows,
      cols: args.cols,
      cwd: args.cwd,
      env: args.env,
      loginShell: args.login_shell,
      preSourceFiles: args.pre_source_files,
      simulatePrecmdHooks: args.simulate_precmd_hooks,
      display: args.display,
      historyLogPath: args.history_log_path,
      viewerWindowTitle: args.viewer_window_title,
      sandbox,
    });
    ctx.registry.registerSession(session);
    return ok({
      session_id: session.id,
      pid: session.pid,
      status: session.getStatus(),
      viewer_pid: session.viewer?.pid ?? null,
      history_log_path: session.getHistoryStats().path,
    });
  }),

  "terminal.write": withParse(schemas.TerminalWriteShape, async (args, ctx) => {
    const s = ctx.registry.getSession(args.session_id);
    if (!s) return notFound("session", args.session_id);
    s.write(args.text);
    return ok({});
  }),

  "terminal.send_key": withParse(schemas.TerminalSendKeyShape, async (args, ctx) => {
    const s = ctx.registry.getSession(args.session_id);
    if (!s) return notFound("session", args.session_id);
    s.sendKey(args.key);
    return ok({});
  }),

  "terminal.snapshot": withParse(schemas.TerminalSnapshotShape, async (args, ctx) => {
    const s = ctx.registry.getSession(args.session_id);
    if (!s) return notFound("session", args.session_id);
    const range = args.range === undefined
      ? undefined
      : (typeof args.range === "string" ? args.range : { lastLines: args.range.last_lines });
    const snap = s.snapshot({ range });
    const stats = s.getHistoryStats();
    return ok({
      session_id: s.id,
      rows: s.resolvedConfig.rows,
      cols: s.resolvedConfig.cols,
      status: s.getStatus(),
      text: snap.plainText,
      lines: snap.plainLines,
      ansi_text: args.include_ansi ? snap.ansiText : undefined,
      cursor: snap.cursor,
      raw_truncated: stats.truncated,
      raw_tail: args.include_raw_tail ? s.getRawHistory().slice(-4096) : undefined,
      range: snap.range,
    });
  }),

  "terminal.get_history": withParse(schemas.TerminalGetHistoryShape, async (args, ctx) => {
    const s = ctx.registry.getSession(args.session_id);
    if (!s) return notFound("session", args.session_id);
    const stats = s.getHistoryStats();
    if (args.format === "raw") {
      return ok({ content: s.getRawHistory(), stats });
    }
    if (args.format === "bytes") {
      return ok({ content: s.getRawHistoryBytes().toString("base64"), stats });
    }
    return ok({ content: s.getCleanHistory(), stats });
  }),

  "terminal.expect_text": withParse(schemas.TerminalExpectTextShape, async (args, ctx) => {
    const s = ctx.registry.getSession(args.session_id);
    if (!s) return notFound("session", args.session_id);
    await s.waitForText(args.text, { timeoutMs: args.timeout_ms });
    return ok({ matched: true });
  }),

  "terminal.expect_regex": withParse(schemas.TerminalExpectRegexShape, async (args, ctx) => {
    const s = ctx.registry.getSession(args.session_id);
    if (!s) return notFound("session", args.session_id);
    const re = new RegExp(args.pattern, args.flags);
    await s.waitForRegex(re, { timeoutMs: args.timeout_ms });
    return ok({ matched: true });
  }),

  "terminal.expect_idle": withParse(schemas.TerminalExpectIdleShape, async (args, ctx) => {
    const s = ctx.registry.getSession(args.session_id);
    if (!s) return notFound("session", args.session_id);
    await s.waitForIdle({ stabilityMs: args.idle_ms, timeoutMs: args.max_wait_ms });
    return ok({});
  }),

  "terminal.expect_change": withParse(schemas.TerminalExpectChangeShape, async (args, ctx) => {
    const s = ctx.registry.getSession(args.session_id);
    if (!s) return notFound("session", args.session_id);
    await s.waitForChange({ timeoutMs: args.max_wait_ms });
    return ok({});
  }),

  "terminal.wait_exit": withParse(schemas.TerminalWaitExitShape, async (args, ctx) => {
    const s = ctx.registry.getSession(args.session_id);
    if (!s) return notFound("session", args.session_id);
    await s.waitForExit({ timeoutMs: args.max_wait_ms });
    const stat = s.stats();
    return ok({ exit_code: stat.exitCode, signal: stat.exitSignal ?? null });
  }),

  "terminal.resize": withParse(schemas.TerminalResizeShape, async (args, ctx) => {
    const s = ctx.registry.getSession(args.session_id);
    if (!s) return notFound("session", args.session_id);
    s.resize(args.rows, args.cols);
    return ok({});
  }),

  "terminal.get_env": withParse(schemas.TerminalGetEnvShape, async (args, ctx) => {
    const s = ctx.registry.getSession(args.session_id);
    if (!s) return notFound("session", args.session_id);
    return ok({ env: args.redact ? redactSecrets(s.originalEnv) : s.originalEnv });
  }),

  "terminal.dump_artifacts": withParse(schemas.TerminalDumpArtifactsShape, async (args, ctx) => {
    const s = ctx.registry.getSession(args.session_id);
    if (!s) return notFound("session", args.session_id);
    const r = s.dumpArtifacts({
      dir: args.dir,
      includeAnsiSnapshot: args.include_ansi_snapshot,
    });
    return ok({ dir: r.dir, files: r.files, total_bytes: r.totalBytes });
  }),

  "terminal.close_session": withParse(schemas.TerminalCloseSessionShape, async (args, ctx) => {
    const s = ctx.registry.getSession(args.session_id);
    if (!s) return notFound("session", args.session_id);
    const r = await s.close({ kill: args.kill, gracefulTimeoutMs: args.graceful_timeout_ms });
    ctx.registry.unregisterSession(args.session_id);
    return ok({ status: s.getStatus(), exit_code: r.exitCode });
  }),

  "terminal.env_snapshot": withParse(schemas.TerminalEnvSnapshotShape, async (args, ctx) => {
    const s = ctx.registry.getSession(args.session_id);
    if (!s) return notFound("session", args.session_id);
    const snap = s.envSnapshot(args.name, { mode: args.mode });
    return ok({ id: snap.name, env: snap.env, captured_at: snap.capturedAt, mode: snap.mode });
  }),

  // ── sandbox.* ───────────────────────────────────────────────────────────
  "sandbox.create": withParse(schemas.SandboxCreateShape, async (args, _ctx) => {
    const ref = createSandbox({
      config: { mode: args.mode, path: args.path, profile: args.profile, isolateTemp: args.isolate_temp },
      manager: { maxConcurrentSandboxes: 16 },
    });
    return ok({ id: ref.id, path: ref.path, mode: ref.mode, profile: ref.profile, created_at: ref.createdAt.toISOString() });
  }),

  "sandbox.destroy": withParse(schemas.SandboxDestroyShape, async (args, _ctx) => {
    destroySandbox(args.sandbox_id);
    return ok({});
  }),

  "sandbox.install": withParse(schemas.SandboxInstallShape, async (args, _ctx) => {
    const sandbox = getSandbox(args.sandbox_id);
    if (!sandbox) return notFound("sandbox", args.sandbox_id);
    const cache = new DownloadCache({
      cacheDir: args.cache_dir ?? null,
      maxBytes: args.cache_max_bytes ?? 10 * 1024 ** 3,
    });
    const result = await installVersion({
      sandbox,
      tool: args.tool,
      version: args.version,
      downloadSources: args.download_sources as DownloadSourceMap,
      cache,
      expectedSha256: args.expected_sha256,
    });
    return ok({
      binary_path: result.binaryPath,
      tarball: result.tarball,
      sha256: result.sha256,
      cache_hit: result.cacheHit,
    });
  }),

  // ── assert.* ─────────────────────────────────────────────────────────────
  "assert.snapshot": withParse(schemas.AssertSnapshotShape, async (args, ctx) => {
    const s = ctx.registry.getSession(args.session_id);
    if (!s) return notFound("session", args.session_id);
    const screen = s.snapshot({ range: "viewport" });
    assertSnapshot({
      rootDir: args.root_dir,
      testFileId: args.test_file_id,
      caseName: args.name,
      maskPresets: args.masks,
      masks: args.inline_masks,
      includeAnsi: args.include_ansi,
      actual: { plain: screen.plainText, ansi: args.include_ansi ? screen.ansiText : undefined },
    });
    return ok({ matched: true });
  }),

  "assert.env_no_path_duplicates": withParse(schemas.AssertEnvNoPathDuplicatesShape, async (args, ctx) => {
    const s = ctx.registry.getSession(args.session_id);
    if (!s) return notFound("session", args.session_id);
    s.assertEnvNoPathDuplicates(args.snapshot_name);
    return ok({ matched: true });
  }),

  "assert.env_diff": withParse(schemas.AssertEnvDiffShape, async (args, ctx) => {
    const s = ctx.registry.getSession(args.session_id);
    if (!s) return notFound("session", args.session_id);
    s.assertEnvDiff(args.before_name, args.after_name, {
      allowedChanges: args.allowed_changes.map((c) => ({
        key: c.key, op: c.op, ...(c.value_pattern ? { valuePattern: c.value_pattern } : {}),
      })),
    });
    return ok({ matched: true });
  }),

  "assert.file_unchanged": withParse(schemas.AssertFileUnchangedShape, async (args, ctx) => {
    const s = ctx.registry.getSession(args.session_id);
    if (!s) return notFound("session", args.session_id);
    s.assertFileUnchanged(args.path, { baselineId: args.baseline_id });
    return ok({ matched: true });
  }),

  "assert.idempotent_install": withParse(schemas.AssertIdempotentInstallShape, async (args, ctx) => {
    const s = ctx.registry.getSession(args.session_id);
    if (!s) return notFound("session", args.session_id);
    const completionRe = new RegExp(args.completion_pattern, "m");
    await s.assertIdempotentInstall({
      filesToCompare: args.files_to_compare,
      runCommand: async () => {
        s.write(args.command + "\n");
        await s.waitForRegex(completionRe, { timeoutMs: args.per_round_timeout_ms });
      },
    });
    return ok({ matched: true });
  }),

  "assert.monitored_paths_unchanged": withParse(schemas.AssertMonitoredPathsUnchangedShape, async (args, ctx) => {
    const s = ctx.registry.getSession(args.session_id);
    if (!s) return notFound("session", args.session_id);
    const completionRe = new RegExp(args.completion_pattern, "m");
    await s.assertMonitoredPathsUnchanged({
      monitorPaths: args.monitor_paths,
      runCommand: async () => {
        s.write(args.command + "\n");
        await s.waitForRegex(completionRe, { timeoutMs: args.per_round_timeout_ms });
      },
    });
    return ok({ matched: true });
  }),
};

// ─── helpers ────────────────────────────────────────────────────────────────

function withParse<S extends z.ZodRawShape>(
  shape: S,
  fn: (args: z.infer<z.ZodObject<S>>, ctx: DispatchContext) => Promise<ToolResult>,
): (args: unknown, ctx: DispatchContext) => Promise<ToolResult> {
  const schema = z.object(shape);
  return async (args: unknown, ctx: DispatchContext) => {
    const parsed = schema.safeParse(args);
    if (!parsed.success) {
      return {
        ok: false,
        error_code: "E_TT_INVALID_INPUT",
        message: parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; "),
        details: { issues: parsed.error.issues },
      };
    }
    try {
      return await fn(parsed.data, ctx);
    } catch (err) {
      return wrapError(err);
    }
  };
}

function ok(rest: Record<string, unknown>): SuccessResult {
  return { ok: true, ...rest };
}

function notFound(kind: string, id: string): ErrorResult {
  return {
    ok: false,
    error_code: kind === "session" ? "E_TT_SESSION_NOT_FOUND" : "E_TT_SANDBOX_NOT_FOUND",
    message: `${kind} not found: ${id}`,
    hint: `make sure the ${kind} was created first and not yet ${kind === "session" ? "closed" : "destroyed"}`,
  };
}

function wrapError(err: unknown): ErrorResult {
  if (isTestableTerminalError(err)) {
    const out: ErrorResult = {
      ok: false,
      error_code: err.code,
      message: err.message,
    };
    if (err.details) out.details = err.details;
    const detailsHint = err.details && typeof err.details === "object" && err.details !== null
      ? (err.details as Record<string, unknown>).hint
      : undefined;
    if (typeof detailsHint === "string") out.hint = detailsHint;
    return out;
  }
  return {
    ok: false,
    error_code: "UNKNOWN",
    message: (err as Error).message ?? String(err),
  };
}

function redactSecrets(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (/(KEY|TOKEN|SECRET|PASSWORD)/i.test(k)) out[k] = "***REDACTED***";
    else out[k] = v;
  }
  return out;
}

// ─── server registration ─────────────────────────────────────────────────────

/**
 * Map of tool name → zod raw shape, exposed to the SDK as inputSchema.
 *
 * Critical: SDK's `tool()` overload without a schema delivers a `(extra)`
 * callback — args are unreachable. Registering `inputSchema` is what causes
 * `(args, extra)` to fire correctly. We re-validate inside `withParse` so
 * SDK schema enforcement doesn't bypass our error envelope on extra fields.
 */
const TOOL_SCHEMAS: Record<schemas.ToolName, z.ZodRawShape> = {
  "terminal.create_session": schemas.TerminalCreateSessionShape,
  "terminal.write": schemas.TerminalWriteShape,
  "terminal.send_key": schemas.TerminalSendKeyShape,
  "terminal.snapshot": schemas.TerminalSnapshotShape,
  "terminal.get_history": schemas.TerminalGetHistoryShape,
  "terminal.expect_text": schemas.TerminalExpectTextShape,
  "terminal.expect_regex": schemas.TerminalExpectRegexShape,
  "terminal.expect_idle": schemas.TerminalExpectIdleShape,
  "terminal.expect_change": schemas.TerminalExpectChangeShape,
  "terminal.wait_exit": schemas.TerminalWaitExitShape,
  "terminal.resize": schemas.TerminalResizeShape,
  "terminal.get_env": schemas.TerminalGetEnvShape,
  "terminal.dump_artifacts": schemas.TerminalDumpArtifactsShape,
  "terminal.close_session": schemas.TerminalCloseSessionShape,
  "terminal.env_snapshot": schemas.TerminalEnvSnapshotShape,
  "sandbox.create": schemas.SandboxCreateShape,
  "sandbox.destroy": schemas.SandboxDestroyShape,
  "sandbox.install": schemas.SandboxInstallShape,
  "assert.snapshot": schemas.AssertSnapshotShape,
  "assert.env_no_path_duplicates": schemas.AssertEnvNoPathDuplicatesShape,
  "assert.env_diff": schemas.AssertEnvDiffShape,
  "assert.file_unchanged": schemas.AssertFileUnchangedShape,
  "assert.idempotent_install": schemas.AssertIdempotentInstallShape,
  "assert.monitored_paths_unchanged": schemas.AssertMonitoredPathsUnchangedShape,
};

export function registerAllTools(server: McpServer, registry: ToolRegistry): void {
  for (const name of Object.keys(HANDLERS) as schemas.ToolName[]) {
    const handler = HANDLERS[name];
    const inputSchema = TOOL_SCHEMAS[name];
    server.registerTool(
      name,
      { inputSchema },
      async (args: unknown) => {
        const result = await handler(args, { registry });
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          isError: !result.ok,
        };
      },
    );
  }
}
