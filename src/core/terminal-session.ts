/**
 * Session — PTY orchestration + lifecycle + event emission.
 *
 * Per round 12 split plan, this file is the "thin spine":
 *   - construct: pull resolved config, wire term + proc, register for cleanup
 *   - attach: PTY → term (write-completion callback drives screen-changed)
 *             term → PTY (reverse wire for capability-query responses)
 *             multi-route to history + mirror + emit('data')
 *   - input methods: write / sendKey / resize
 *   - snapshot: delegates to snapshot.ts
 *   - waiters: delegates to waiters.ts via WaitContext
 *   - history: delegates to SessionHistory
 *   - events: ring buffer of TerminalEvent for forensic dump (M3)
 *   - dumpArtifacts: delegates to artifacts.ts
 *   - close: kill + flush
 *
 * Intentional non-goals (kept in sibling modules):
 *   - viewer launching → viewer-bridge.ts
 *   - 5 wait functions  → waiters.ts
 *   - ring buffer       → history.ts
 *   - signal cleanup    → process-cleanup.ts
 *   - artifact dump     → artifacts.ts
 *   - high-level helpers → high-level/ask-claude.ts
 */

import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";

import { wrapWithLoginShell } from "./shell-wrap.js";
import { readScreen, type ScreenRead, type SnapshotRange } from "./snapshot.js";
import { setupDisplay, type ViewerBridgeOutput } from "./session/viewer-bridge.js";
import { SessionHistory } from "./session/history.js";
import {
  waitForChange, waitForExit, waitForIdle, waitForReady, waitForRegex, waitForText,
  type WaitContext, type WaitForIdleOptions, type WaitForReadyOptions, type WaitOptions,
} from "./session/waiters.js";
import { registerForCleanup } from "./process-cleanup.js";
import { newSessionId } from "../utils/id.js";
import { dumpArtifacts, defaultDumpDirName, type DumpResult } from "./artifacts.js";
import { platform as hostPlatform } from "./platform.js";
import { buildSandboxEnv } from "./sandbox/env-injector.js";
import { captureEnvSnapshot } from "./install-test/env-snapshot.js";
import { autoBaseline, hashFile } from "./install-test/file-baseline.js";
import { assertEnvNoPathDuplicates } from "./install-test/asserts/env-no-path-duplicates.js";
import { assertEnvDiff } from "./install-test/asserts/env-diff.js";
import { assertFileUnchanged } from "./install-test/asserts/file-unchanged.js";
import { assertIdempotentInstall } from "./install-test/asserts/idempotent-install.js";
import {
  assertMonitoredPathsUnchanged, snapshotMonitoredPaths,
} from "./install-test/asserts/monitored-paths-unchanged.js";
import type {
  AllowedEnvChange, DisplayMode, EnvInheritanceConfig, EnvSnapshot,
  EnvSnapshotMode, FileBaseline, HistoryStats, ResolvedDisplayMode,
  SandboxRef, TerminalEvent, TerminalEventType,
  TerminalKey, TerminalSessionStatus,
} from "./types.js";
import type { ViewerHandle } from "./viewer.js";

const require = createRequire(import.meta.url);
const pty = require("node-pty") as typeof import("node-pty");
const xtermHeadless = require("@xterm/headless") as typeof import("@xterm/headless");
const { Terminal } = xtermHeadless;
type IPty = import("node-pty").IPty;
type TerminalCls = InstanceType<typeof Terminal>;

// ─── key sequences ───────────────────────────────────────────────────────────

const KEY_SEQUENCES: Record<TerminalKey, string> = {
  enter: "\r",
  tab: "\t",
  esc: "\x1b",
  backspace: "\x7f",
  ctrl_c: "\x03",
  ctrl_d: "\x04",
  ctrl_l: "\x0c",
  arrow_up: "\x1b[A",
  arrow_down: "\x1b[B",
  arrow_left: "\x1b[D",
  arrow_right: "\x1b[C",
};

// ─── default redact patterns (used when caller doesn't plumb config) ────────

const DEFAULT_REDACT_ENV_PATTERNS = [
  "*KEY*", "*TOKEN*", "*SECRET*", "*PASSWORD*",
  "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "KIMI_API_KEY", "AIKEY_*",
] as const;

// ─── config ──────────────────────────────────────────────────────────────────

export interface SessionConfig {
  command: string;
  args?: string[];
  rows?: number;
  cols?: number;
  cwd?: string;
  env?: Record<string, string>;
  loginShell?: boolean;
  /** Debounce after PTY data arrives before emitting screen-changed. */
  changeDebounceMs?: number;
  /** Mirror raw PTY output to host stdout (debug). Don't use under MCP. */
  mirror?: boolean;
  display?: DisplayMode;
  /**
   * Files to source in the wrap shell before exec'ing the command. Useful
   * for tools whose env is set by an interactive `precmd` / prompt hook
   * that doesn't fire in non-interactive `-ilc 'cmd'` runs (e.g. aikey's
   * `~/.aikey/active.env`, nvm/direnv state). Tilde is expanded.
   * Only meaningful when `loginShell: true`.
   */
  preSourceFiles?: ReadonlyArray<string>;
  /**
   * Manually invoke the shell's precmd / PROMPT_COMMAND hook chain before
   * exec. Zero-config alternative to `preSourceFiles` for hook-based tools
   * (aikey, nvm, direnv, pyenv, atuin, ...) — triggers their actual hook
   * functions instead of requiring callers to know which file to source.
   * Auto-detects zsh vs bash. Only meaningful when `loginShell: true`.
   */
  simulatePrecmdHooks?: boolean;
  /** Caller-explicit history log path. Auto-created when display=open-terminal and unset. */
  historyLogPath?: string;
  viewerWindowTitle?: string;
  /** Max bytes in history ring buffer. Default 20MB. */
  maxHistoryBytes?: number;
  /** Max events in lifecycle ring buffer (used by dumpArtifacts). Default 1000. */
  maxEvents?: number;
  /** Glob patterns for env redaction in artifact dump. Defaults to common secret shapes. */
  redactEnvPatterns?: ReadonlyArray<string>;

  // ── sandbox (M4) ────────────────────────────────────────────────────────
  /** Reference to a sandbox created by sandboxManager.create(). When set, env */
  /** is rebuilt via env-injector (virtual HOME, PATH overlay, denyKeys gate); */
  /** cwd defaults to sandbox.path if not explicitly set. */
  sandbox?: SandboxRef;
  /** Override default env inheritance config. */
  envInheritance?: Partial<EnvInheritanceConfig>;
  /** When true, point TMPDIR/TEMP/TMP into sandbox/tmp. Default false. */
  isolateTemp?: boolean;
  /** Whitelist for envInheritance.mode=whitelist. */
  passthroughEnvKeys?: ReadonlyArray<string>;
}

const DEFAULT_ENV_INHERITANCE: EnvInheritanceConfig = {
  mode: "all_with_overlay",
  denyKeys: [
    "*KEY*", "*TOKEN*", "*SECRET*", "*PASSWORD*",
    "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "KIMI_API_KEY", "AIKEY_*",
  ],
  allowCallerSecretEnv: true,
  strictDeny: false,
};

const DEFAULT_PASSTHROUGH_ENV_KEYS: ReadonlyArray<string> = [
  "TERM", "LANG", "LC_ALL", "LC_CTYPE", "USER", "SHELL", "COLORTERM",
  "HOME", "PATH", "SystemRoot", "windir",
];

const DEFAULTS = {
  rows: 40,
  cols: 120,
  loginShell: false,
  changeDebounceMs: 50,
  maxHistoryBytes: 20 * 1024 * 1024,
  maxEvents: 1000,
};

// ─── resolved meta (frozen view of the spawn-time config; used by artifact dump) ─

export interface ResolvedSessionMeta {
  command: string;
  args: string[];
  cwd: string;
  rows: number;
  cols: number;
  redactEnvPatterns: ReadonlyArray<string>;
}

// ─── constructor argument bundle (internal) ─────────────────────────────────

interface SessionInternals {
  term: TerminalCls;
  proc: IPty;
  bridge: ViewerBridgeOutput;
  history: SessionHistory;
  mirror: boolean;
  changeDebounceMs: number;
  id: string;
  createdAt: Date;
  originalEnv: Record<string, string>;
  resolvedConfig: ResolvedSessionMeta;
  maxEvents: number;
  sandbox: SandboxRef | null;
}

// ─── Session class ───────────────────────────────────────────────────────────

export class Session extends EventEmitter {
  readonly id: string;
  readonly term: TerminalCls;
  readonly proc: IPty;
  readonly pid: number;
  readonly viewer: ViewerHandle | null;
  readonly display: ResolvedDisplayMode;
  readonly createdAt: Date;
  /** Caller-provided env at construction time (for artifact dump). */
  readonly originalEnv: Record<string, string>;
  readonly resolvedConfig: ResolvedSessionMeta;
  readonly sandbox: SandboxRef | null;

  private readonly history: SessionHistory;
  private readonly mirror: boolean;
  private readonly changeDebounceMs: number;
  private readonly eventBuffer: TerminalEvent[] = [];
  private readonly maxEvents: number;

  /** Captured env snapshots, keyed by name (M6). */
  private readonly envSnapshots = new Map<string, EnvSnapshot>();
  /** Auto + caller-explicit file baselines (M6). */
  private readonly fileBaselines: FileBaseline[] = [];

  private debounceTimer: NodeJS.Timeout | null = null;
  private exited = false;
  private exitCode: number | null = null;
  private exitSignal: number | undefined = undefined;
  private dataChunks = 0;
  private status: TerminalSessionStatus = "running";

  private constructor(args: SessionInternals) {
    super();
    this.id = args.id;
    this.term = args.term;
    this.proc = args.proc;
    this.pid = args.proc.pid;
    this.viewer = args.bridge.viewer;
    this.display = args.bridge.display;
    this.createdAt = args.createdAt;
    this.originalEnv = args.originalEnv;
    this.resolvedConfig = args.resolvedConfig;
    this.sandbox = args.sandbox;
    this.history = args.history;
    this.mirror = args.mirror;
    this.changeDebounceMs = args.changeDebounceMs;
    this.maxEvents = args.maxEvents;
    this.recordEvent("session.created");
    this.recordEvent("session.started", { pid: args.proc.pid });

    // M6 auto-baseline: hash standard rc files at session create so callers
    // can `assertFileUnchanged(".bashrc")` without an explicit pre-baseline.
    if (this.sandbox) {
      this.fileBaselines.push(...autoBaseline({ sandbox: this.sandbox }));
    }

    this.attach();
  }

  // ─── attach: bidirectional wiring ─────────────────────────────────────────

  private attach(): void {
    // Forward direction: PTY → term + history + mirror + emit('data').
    this.proc.onData((data: string) => {
      this.dataChunks += 1;

      // Synchronous side effects (don't depend on parser state).
      if (this.mirror) process.stdout.write(data);
      this.history.append(data);
      this.recordEvent("output.data", { bytes: Buffer.byteLength(data, "utf8") });
      this.emit("data", data);

      // Round 10 fix: xterm parses asynchronously. Use write-completion
      // callback as the trigger for screen-changed — guarantees the
      // buffer reflects this chunk before any waiter reads it.
      this.term.write(data, () => { this.scheduleChange(); });
    });

    // Round 11 fix: reverse direction. xterm.headless synthesizes responses
    // to capability queries (DSR `\x1b[6n` cursor pos, Primary DA `\x1b[c`,
    // OSC 10/11) — without this wire, those responses are dropped, and
    // strict TUIs (codex 0.128+) hang after banner waiting for a reply.
    this.term.onData((response: string) => {
      try {
        this.proc.write(response);
      } catch {
        // PTY closed mid-response — harmless, the TUI is gone anyway.
      }
    });

    this.proc.onExit(({ exitCode, signal }) => {
      this.exited = true;
      this.exitCode = exitCode;
      this.exitSignal = signal;
      // status only flips to "exited" if we weren't already mid-close.
      if (this.status === "running") this.status = "exited";
      this.recordEvent("process.exit", { exitCode, signal: signal ?? null });
      this.flushChange();
      this.history.endDiskStream();
      this.emit("exit");
    });
  }

  /** Schedule a debounced "screen-changed" emission. */
  private scheduleChange(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.emit("screen-changed");
    }, this.changeDebounceMs);
  }

  /** Force-emit any pending screen-changed (called on exit so waiters wake). */
  private flushChange(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
      this.emit("screen-changed");
    }
  }

  /** Push a lifecycle event into the ring buffer (FIFO drop on overflow). */
  private recordEvent(type: TerminalEventType, data?: unknown): void {
    const ev: TerminalEvent = {
      type,
      ts: new Date().toISOString(),
      session_id: this.id,
      ...(data !== undefined ? { data } : {}),
    };
    this.eventBuffer.push(ev);
    while (this.eventBuffer.length > this.maxEvents) this.eventBuffer.shift();
  }

  // ─── input methods ────────────────────────────────────────────────────────

  /**
   * Write raw text to the PTY. Does NOT auto-append `\r` — round 6 lesson:
   * Ink-based TUIs (Claude/Kimi) treat text+\r as bracketed paste and eat
   * the Enter. Always send Enter via `sendKey("enter")` separately.
   */
  write(text: string): void {
    if (this.exited) throw new Error("Session has exited");
    this.recordEvent("input.write", { bytes: Buffer.byteLength(text, "utf8") });
    this.proc.write(text);
  }

  sendKey(key: TerminalKey): void {
    if (this.exited) throw new Error("Session has exited");
    this.recordEvent("input.key", { key });
    this.proc.write(KEY_SEQUENCES[key]);
  }

  resize(rows: number, cols: number): void {
    if (this.exited) return;
    this.recordEvent("resize", { rows, cols });
    this.proc.resize(cols, rows);
    this.term.resize(cols, rows);
  }

  // ─── synchronous reads ────────────────────────────────────────────────────

  snapshot(opts: { range?: SnapshotRange } = {}): ScreenRead {
    return readScreen(this.term, opts.range);
  }

  stats(): { rawBytes: number; dataChunks: number; exited: boolean; exitCode: number | null; exitSignal: number | undefined } {
    return {
      rawBytes: this.history.getHistoryStats().bytes,
      dataChunks: this.dataChunks,
      exited: this.exited,
      exitCode: this.exitCode,
      exitSignal: this.exitSignal,
    };
  }

  /** Status reflects the lifecycle state-machine: running → exited / killed / failed. */
  getStatus(): TerminalSessionStatus { return this.status; }

  /** Read-only view of accumulated lifecycle events (oldest first). */
  getEvents(): TerminalEvent[] { return this.eventBuffer.slice(); }

  // ─── history API (delegates to SessionHistory) ────────────────────────────

  getRawHistoryBytes(): Buffer { return this.history.getRawHistoryBytes(); }
  getRawHistory(): string      { return this.history.getRawHistory(); }
  getCleanHistory(): string    { return this.history.getCleanHistory(); }
  getHistoryStats(): HistoryStats { return this.history.getHistoryStats(); }

  // ─── waiters (delegate to waiters.ts via WaitContext) ─────────────────────

  private waitContext(): WaitContext {
    return {
      emitter: this as unknown as WaitContext["emitter"],
      snapshot: () => this.snapshot(),
      isExited: () => this.exited,
    };
  }

  waitForRegex(re: RegExp, opts?: WaitOptions): ReturnType<typeof waitForRegex> {
    return waitForRegex(this.waitContext(), re, opts);
  }
  waitForText(text: string, opts?: WaitOptions): ReturnType<typeof waitForText> {
    return waitForText(this.waitContext(), text, opts);
  }
  waitForIdle(opts?: WaitForIdleOptions): ReturnType<typeof waitForIdle> {
    return waitForIdle(this.waitContext(), opts);
  }
  waitForReady(opts: WaitForReadyOptions): ReturnType<typeof waitForReady> {
    return waitForReady(this.waitContext(), opts);
  }
  waitForChange(opts?: WaitOptions): ReturnType<typeof waitForChange> {
    return waitForChange(this.waitContext(), opts);
  }
  waitForExit(opts?: WaitOptions): ReturnType<typeof waitForExit> {
    return waitForExit(this.waitContext(), opts);
  }

  // ─── install-test toolkit (M6) ────────────────────────────────────────────

  /**
   * Capture an env snapshot under `name`. Default mode for install-test
   * scenarios is `fresh-login` — installer rc-file writes only show up via
   * a fresh shell. Use `current` only when you specifically want the
   * running session's env.
   */
  envSnapshot(name: string, opts: { mode?: EnvSnapshotMode } = {}): EnvSnapshot {
    if (!this.sandbox) {
      throw new Error("envSnapshot requires the session to have a sandbox attached");
    }
    const mode = opts.mode ?? "fresh-login";
    const snap = captureEnvSnapshot({
      name,
      mode,
      sandbox: this.sandbox,
      currentSessionEnv: mode === "current" ? this.originalEnv : undefined,
    });
    this.envSnapshots.set(name, snap);
    return snap;
  }

  /** Look up an envSnapshot stored on this session. */
  getEnvSnapshot(name: string): EnvSnapshot | null {
    return this.envSnapshots.get(name) ?? null;
  }

  /** Capture a fresh file baseline for `path`. Stored on the session. */
  fileBaseline(pathKey: string, opts: { id?: string } = {}): FileBaseline {
    if (!this.sandbox) throw new Error("fileBaseline requires the session to have a sandbox attached");
    const id = opts.id ?? `manual-${this.fileBaselines.length}`;
    const abs = path.isAbsolute(pathKey) ? pathKey : path.join(this.sandbox.path, pathKey);
    const b = hashFile({ id, path: pathKey, absolutePath: abs });
    this.fileBaselines.push(b);
    return b;
  }

  /** Read-only copy of the captured baselines. */
  getFileBaselines(): FileBaseline[] {
    return this.fileBaselines.slice();
  }

  // ── 5 assert tools ──────────────────────────────────────────────────────

  assertEnvNoPathDuplicates(snapshotName: string): void {
    const snap = this.requireSnapshot(snapshotName);
    assertEnvNoPathDuplicates({ snapshot: snap });
  }

  assertEnvDiff(beforeName: string, afterName: string, opts: { allowedChanges?: ReadonlyArray<AllowedEnvChange> } = {}): void {
    const before = this.requireSnapshot(beforeName);
    const after = this.requireSnapshot(afterName);
    assertEnvDiff({ before, after, allowedChanges: opts.allowedChanges });
  }

  assertFileUnchanged(pathKey: string, opts: { baselineId?: string } = {}): void {
    if (!this.sandbox) throw new Error("assertFileUnchanged requires sandbox");
    assertFileUnchanged({
      sandbox: this.sandbox,
      path: pathKey,
      baselines: this.fileBaselines,
      baselineId: opts.baselineId,
    });
  }

  /**
   * Run the supplied `runCommand` twice and assert idempotence.
   * Caller decides how to actually run the command (PTY write+wait, async
   * spawn, etc.) — Session just orchestrates snapshots and diff.
   */
  async assertIdempotentInstall(opts: {
    runCommand: () => Promise<void>;
    filesToCompare: ReadonlyArray<string>;
    /** When omitted, fresh-login env capture is used (the install-test default). */
    envMode?: EnvSnapshotMode;
  }): Promise<void> {
    if (!this.sandbox) throw new Error("assertIdempotentInstall requires sandbox");
    const sandbox = this.sandbox;
    const mode = opts.envMode ?? "fresh-login";
    return assertIdempotentInstall({
      sandbox,
      runCommand: opts.runCommand,
      filesToCompare: opts.filesToCompare,
      captureEnv: async (name) => {
        const snap = captureEnvSnapshot({
          name, mode, sandbox,
          currentSessionEnv: mode === "current" ? this.originalEnv : undefined,
        });
        this.envSnapshots.set(name, snap);
        return snap;
      },
    });
  }

  /**
   * Snapshot `monitorPaths` before, run command, snapshot after; throw if
   * anything in the list changed. The caller's runCommand callback runs the
   * command in whatever way they want (PTY shell, child_process, etc.).
   */
  async assertMonitoredPathsUnchanged(opts: {
    runCommand: () => Promise<void>;
    monitorPaths: ReadonlyArray<string>;
  }): Promise<void> {
    const before = snapshotMonitoredPaths(opts.monitorPaths);
    await opts.runCommand();
    const after = snapshotMonitoredPaths(opts.monitorPaths);
    assertMonitoredPathsUnchanged({ before, after });
  }

  private requireSnapshot(name: string): EnvSnapshot {
    const snap = this.envSnapshots.get(name);
    if (!snap) {
      throw new Error(`no env snapshot named "${name}" — call session.envSnapshot("${name}") first`);
    }
    return snap;
  }

  // ─── artifact dump ────────────────────────────────────────────────────────

  /**
   * Drop a forensic snapshot of the session to disk: raw + clean history,
   * current screen, lifecycle events, env (redacted), meta.
   *
   * Dir resolution: `opts.dir` if provided, otherwise `<os.tmpdir()>/ttm-artifacts/<slug>`.
   */
  dumpArtifacts(opts: { dir?: string; includeAnsiSnapshot?: boolean } = {}): DumpResult {
    const slug = defaultDumpDirName(this.id, new Date());
    const outDir = opts.dir ?? path.join(os.tmpdir(), "ttm-artifacts", slug);
    const snap = this.snapshot({ range: "all" });
    return dumpArtifacts(
      {
        sessionId: this.id,
        command: this.resolvedConfig.command,
        args: this.resolvedConfig.args,
        cwd: this.resolvedConfig.cwd,
        rows: this.resolvedConfig.rows,
        cols: this.resolvedConfig.cols,
        status: this.status,
        exitCode: this.exitCode,
        exitSignal: this.exitSignal,
        createdAt: this.createdAt,
        rawHistory: this.history.getRawHistoryBytes(),
        cleanHistory: this.history.getCleanHistory(),
        rawTruncated: this.history.getHistoryStats().truncated,
        screenPlain: snap.plainText,
        screenAnsi: snap.ansiText,
        events: this.eventBuffer.slice(),
        env: this.originalEnv,
        redactEnvPatterns: this.resolvedConfig.redactEnvPatterns,
      },
      { outDir, includeAnsiSnapshot: opts.includeAnsiSnapshot ?? false },
    );
  }

  // ─── lifecycle ────────────────────────────────────────────────────────────

  /** Internal: kill without awaiting exit (used by signal cleanup). */
  kill(signal: string = "SIGTERM"): void {
    if (this.exited) return;
    this.status = "killed";
    this.recordEvent("session.killed", { signal });
    try { this.proc.kill(signal); } catch { /* already dead */ }
  }

  async close(opts: { kill?: boolean; gracefulTimeoutMs?: number } = {}): Promise<{ exitCode: number | null; signal: number | undefined }> {
    const { kill = true, gracefulTimeoutMs = 1500 } = opts;
    if (this.exited) return { exitCode: this.exitCode, signal: this.exitSignal };
    this.recordEvent("session.closed", { kill, gracefulTimeoutMs });
    if (kill) this.kill();

    return new Promise((resolve) => {
      const finish = (): void => {
        clearTimeout(timer);
        // Defensive: if onExit didn't fire (graceful timeout case), still
        // mark exited=true so subsequent write() calls throw cleanly.
        // Caller already asked us to close — they don't want a half-state.
        this.exited = true;
        resolve({ exitCode: this.exitCode, signal: this.exitSignal });
      };
      const timer = setTimeout(finish, gracefulTimeoutMs);
      this.once("exit", finish);
    });
  }

  // ─── factory (called only by startSession below) ──────────────────────────

  /** @internal Used by startSession. Tests should call `startSession()` instead. */
  static __construct(args: SessionInternals): Session {
    return new Session(args);
  }
}

// ─── factory ─────────────────────────────────────────────────────────────────

export async function startSession(config: SessionConfig): Promise<Session> {
  const rows = config.rows ?? DEFAULTS.rows;
  const cols = config.cols ?? DEFAULTS.cols;
  // When a sandbox is attached and caller didn't pin cwd, default into it so
  // shells start at the virtual HOME — matches user expectation that
  // `pwd` shows the sandbox root.
  const cwd = config.cwd ?? config.sandbox?.path ?? process.cwd();
  const loginShell = config.loginShell ?? DEFAULTS.loginShell;
  const changeDebounceMs = config.changeDebounceMs ?? DEFAULTS.changeDebounceMs;
  const mirror = config.mirror ?? false;
  const maxHistoryBytes = config.maxHistoryBytes ?? DEFAULTS.maxHistoryBytes;
  const maxEvents = config.maxEvents ?? DEFAULTS.maxEvents;
  const redactEnvPatterns = config.redactEnvPatterns ?? DEFAULT_REDACT_ENV_PATTERNS;

  // Resolve display + viewer + history log path BEFORE spawning.
  // We don't have pid yet, but the viewer-bridge handles that.
  const bridge = setupDisplay({
    command: config.command,
    display: config.display,
    historyLogPath: config.historyLogPath,
    viewerWindowTitle: config.viewerWindowTitle,
  });

  // Build env: with sandbox → buildSandboxEnv (virtual HOME / PATH overlay /
  // denyKeys / inheritance modes). Without sandbox → simple host inherit +
  // caller overlay (legacy V0 path; pre-M4 behavior preserved for non-sandbox
  // callers).
  const hostEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") hostEnv[k] = v;
  }

  let env: Record<string, string>;
  if (config.sandbox) {
    const inheritance: EnvInheritanceConfig = { ...DEFAULT_ENV_INHERITANCE, ...(config.envInheritance ?? {}) };
    const built = buildSandboxEnv(config.sandbox, hostEnv, {
      envInheritance: inheritance,
      passthroughEnvKeys: config.passthroughEnvKeys ?? DEFAULT_PASSTHROUGH_ENV_KEYS,
      isolateTemp: config.isolateTemp ?? false,
      callerEnv: config.env,
      platform: hostPlatform,
    });
    env = built.env;
  } else {
    env = { ...hostEnv };
    for (const [k, v] of Object.entries(config.env ?? {})) env[k] = v;
  }
  // Always force TERM to a known good value — we drive a 256-color xterm.
  env.TERM = "xterm-256color";

  const wrapped = wrapWithLoginShell({
    command: config.command,
    args: config.args ?? [],
    loginShell,
    preSourceFiles: config.preSourceFiles,
    simulatePrecmdHooks: config.simulatePrecmdHooks,
  });

  const term = new Terminal({ cols, rows, allowProposedApi: true });

  const proc = pty.spawn(wrapped.command, wrapped.args, {
    name: "xterm-256color",
    cols,
    rows,
    cwd,
    env,
  });

  const history = new SessionHistory({
    maxHistoryBytes,
    historyLogPath: bridge.historyLogPath,
  });

  const session = Session.__construct({
    term,
    proc,
    bridge,
    history,
    mirror,
    changeDebounceMs,
    id: newSessionId(),
    createdAt: new Date(),
    originalEnv: { ...(config.env ?? {}) },
    resolvedConfig: {
      command: config.command,
      args: config.args ?? [],
      cwd,
      rows,
      cols,
      redactEnvPatterns,
    },
    maxEvents,
    sandbox: config.sandbox ?? null,
  });

  // Round 10 fix: register AFTER constructing, BEFORE returning, so any
  // SIGINT during the await chain catches an already-tracked session.
  registerForCleanup(session);

  return session;
}
