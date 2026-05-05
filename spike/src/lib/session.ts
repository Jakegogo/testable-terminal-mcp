/**
 * session — high-level, event-driven Terminal session API.
 *
 * Designed as the V1 core/terminal-session prototype. Goals:
 *   - Single source of truth for spike.ts and ask-claude.ts
 *   - Importable from integration tests (vitest / jest / plain async script)
 *   - Fully event-driven: no setInterval polling. PTY onData → 50ms debounce →
 *     emit "screen-changed" → all waiters wake up
 *   - waitForReady replaces fixed dwell (which is fragile, see spike report)
 *
 * Public API:
 *   const session = await startSession({ command, rows, cols, loginShell, ... });
 *   await session.waitForReady();        // event-driven, no fixed sleep
 *   session.write(text); session.sendKey("enter");
 *   await session.waitForRegex(/⏺/);     // event-driven
 *   await session.waitForIdle(1500);     // event-driven
 *   const snap = session.snapshot();     // synchronous
 *   await session.close();
 *
 * High-level helper for the common case:
 *   const { reply } = await askClaude({ prompt: "..." });
 */

import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { wrapWithLoginShell } from "./shell-wrap.js";
import { readScreen as readScreenAnsi, type ScreenRead, type SnapshotRange } from "./screen-ansi.js";
import { openLiveViewer, type ViewerHandle } from "./viewer.js";

const require = createRequire(import.meta.url);
const pty = require("node-pty") as typeof import("node-pty");
const xtermHeadless = require("@xterm/headless") as typeof import("@xterm/headless");
const { Terminal } = xtermHeadless;
type IPty = import("node-pty").IPty;
type TerminalCls = InstanceType<typeof Terminal>;

// ─── types ────────────────────────────────────────────────────────────────────

export type TerminalKey =
  | "enter" | "tab" | "esc" | "backspace"
  | "ctrl_c" | "ctrl_d" | "ctrl_l"
  | "arrow_up" | "arrow_down" | "arrow_left" | "arrow_right";

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
  /** Mirror raw PTY output to host stdout (debug). Don't use under MCP — it pollutes stdio protocol. */
  mirror?: boolean;
  /**
   * Live preview mode.
   *   "headless"      — pure background, no GUI window (default; correct for CI / integration tests)
   *   "open-terminal" — also open a real Terminal window tailing this session's PTY stream live
   *   "auto"          — open-terminal if env looks like a desktop, else headless (CI / SSH detected → headless)
   */
  display?: "headless" | "open-terminal" | "auto";
  /**
   * If set, raw PTY bytes are mirrored to this file as they arrive (append-only).
   * Both the viewer (display=open-terminal) and post-mortem inspection consume
   * this file. If unset, bytes are still accumulated in memory (see
   * maxHistoryBytes) but not written to disk.
   *
   * When display=open-terminal and this is unset, a temp file is auto-created.
   */
  historyLogPath?: string;
  /** Title shown in the viewer window (when display=open-terminal). */
  viewerWindowTitle?: string;
  /**
   * Max bytes kept in the in-memory raw-history ring buffer. When exceeded,
   * oldest chunks are dropped FIFO and `getHistoryStats().truncated` flips true.
   * Default 20 MB. The on-disk file (historyLogPath) is unbounded.
   */
  maxHistoryBytes?: number;
}

export interface WaitOptions {
  timeoutMs?: number;
}

export interface WaitForReadyOptions extends WaitOptions {
  /** Regex marking "TUI input prompt is visible". */
  readyPattern?: RegExp;
  /** After ready pattern seen, wait for screen to stabilize for this long. */
  postReadyStabilityMs?: number;
}

export interface WaitForIdleOptions extends WaitOptions {
  stabilityMs?: number;
  /**
   * If true, the stability timer won't arm until the first screen-changed
   * event arrives. Use this when an empty screen at the start should NOT
   * trigger immediate "idle" resolution (e.g. racing against waitForExit /
   * waitForReady on a freshly-spawned session).
   */
  requireFirstEvent?: boolean;
}

const DEFAULTS = {
  rows: 40,
  cols: 120,
  loginShell: false,
  changeDebounceMs: 50,
  readyTimeoutMs: 30_000,
  readyPattern: /❯|^\$\s|^>\s|%\s$/m,
  postReadyStabilityMs: 600,
  idleStabilityMs: 1_500,
  idleMaxMs: 180_000,
  expectTimeoutMs: 60_000,
  maxHistoryBytes: 20 * 1024 * 1024,    // 20 MB ring buffer
};

export class TerminalTimeoutError extends Error {
  constructor(public readonly kind: string, public readonly snapshot: ScreenRead, message: string) {
    super(message);
    this.name = "TerminalTimeoutError";
  }
}

/**
 * Strip terminal-capability QUERIES from PTY output before mirroring to the
 * user's real terminal (process.stdout).
 *
 * Why: in mirror mode, PTY bytes flow to process.stdout → user's real terminal
 * (e.g. Apple Terminal). When that terminal sees a capability query like
 * `\x1b[6n` it auto-responds, and the response loops back into the TUI's
 * stdin (via process.stdin or controlling-tty fallback), polluting the input
 * field with visible escape junk. Even `< /dev/null` redirection on the npm
 * process doesn't reliably block this — Apple Terminal v470 was observed to
 * reach the inner PTY through some controlling-tty path despite stdin
 * redirection. Solution: strip queries BEFORE the mirror so the real terminal
 * simply never sees them. xterm.headless still receives the full data via
 * term.write() so its parser can synthesize responses (forwarded back to PTY
 * via term.onData → proc.write).
 *
 * What gets stripped (only QUERIES — no display state):
 *   • CSI 6n / 5n        — DSR cursor position / status request
 *   • CSI [>=]?<digits>c — Primary / Secondary / Tertiary Device Attributes
 *   • CSI ?u             — kitty keyboard flags request
 *   • OSC <n>;? ST|BEL   — color queries (10=fg, 11=bg, 4=palette, etc.)
 *
 * What is NOT stripped (display fidelity preserved):
 *   • CSI ?1049h/l       — alt-screen toggle
 *   • CSI ?2004h/l       — bracketed paste mode
 *   • CSI ?1004h/l       — focus reporting (codex enabled it on purpose)
 *   • CSI ?2026h/l       — synchronized output mode
 *   • OSC 0;<title> ST   — set window title
 *   • SGR / cursor moves / text / etc.
 *
 * Note on chunk splits: query escape sequences are short (2-12 bytes) and PTYs
 * deliver them whole in practice, so this single-pass regex is sufficient.
 * If a future TUI sends queries split across PTY reads we may need to add
 * stateful parsing across chunks, but no observed case requires it today.
 */
export function stripTerminalQueriesFromMirror(data: string): string {
  return data
    .replace(/\x1b\[[56]n/g, "")                      // DSR (cursor / status)
    .replace(/\x1b\[[>=]?\d*c/g, "")                  // DA (does NOT match \x1b[?…c — responses, no leading ?)
    .replace(/\x1b\[\?u/g, "")                         // kitty keyboard query
    // OSC <code>(;<param>)*;? <ST|BEL>: color queries (10=fg, 11=bg, 12=cursor, 4;<n>=palette).
    // The (?:;\d+)* allows multi-param forms like `\x1b]4;3;?\x07` (palette index 3 query).
    .replace(/\x1b\]\d+(?:;\d+)*;\?(?:\x1b\\|\x07)/g, "");
}

// ─── Session class ────────────────────────────────────────────────────────────

export class Session extends EventEmitter {
  readonly term: TerminalCls;
  readonly proc: IPty;
  readonly pid: number;
  readonly config: Required<Omit<SessionConfig, "display" | "historyLogPath" | "viewerWindowTitle" | "maxHistoryBytes">> & {
    display: "headless" | "open-terminal";
    historyLogPath: string | null;
    viewerWindowTitle: string;
    maxHistoryBytes: number;
  };

  /** null when display=headless. */
  readonly viewer: ViewerHandle | null;

  private dataChunks = 0;
  private debounceTimer: NodeJS.Timeout | null = null;
  private exited = false;
  private exitCode: number | null = null;
  private exitSignal: number | undefined = undefined;
  private historyLogStream: fs.WriteStream | null = null;

  // Raw history ring buffer (bytes accumulated, oldest dropped when over limit).
  private rawChunks: Buffer[] = [];
  private rawBytes = 0;
  private rawTruncated = false;

  constructor(
    config: SessionConfig,
    term: TerminalCls,
    proc: IPty,
    resolved: {
      display: "headless" | "open-terminal";
      historyLogPath: string | null;
      viewerWindowTitle: string;
      viewer: ViewerHandle | null;
    },
  ) {
    super();
    this.config = {
      command: config.command,
      args: config.args ?? [],
      rows: config.rows ?? DEFAULTS.rows,
      cols: config.cols ?? DEFAULTS.cols,
      cwd: config.cwd ?? process.cwd(),
      env: config.env ?? {},
      loginShell: config.loginShell ?? DEFAULTS.loginShell,
      changeDebounceMs: config.changeDebounceMs ?? DEFAULTS.changeDebounceMs,
      mirror: config.mirror ?? false,
      display: resolved.display,
      historyLogPath: resolved.historyLogPath,
      viewerWindowTitle: resolved.viewerWindowTitle,
      maxHistoryBytes: config.maxHistoryBytes ?? DEFAULTS.maxHistoryBytes,
    };
    this.term = term;
    this.proc = proc;
    this.pid = proc.pid;
    this.viewer = resolved.viewer;
    if (resolved.historyLogPath) {
      this.historyLogStream = fs.createWriteStream(resolved.historyLogPath, { flags: "a" });
    }
    this.attach();
  }

  private attach(): void {
    this.proc.onData((data: string) => {
      this.dataChunks += 1;
      // round 9 review fix: xterm parses asynchronously. Use the write-completion
      // callback as the trigger for screen-changed scheduling so waiters never
      // read a snapshot whose buffer is still being populated. Mirror / log /
      // history buffer are independent of parser state and run synchronously.
      //
      // Mirror path: strip terminal-capability QUERIES so the user's real
      // terminal (downstream of process.stdout) doesn't see them and
      // auto-respond. See stripTerminalQueriesFromMirror() doc + bugfix
      // notes in `update/spike-验证结果.md` 坑 4. Without stripping, on
      // Apple Terminal v470 (and any auto-responding emulator) the visible
      // escape sequences would loop back into the PTY as junk in codex's
      // input field. Other paths (historyLog, rawHistory, term.write) get
      // the full unmodified data — only the mirror is filtered.
      if (this.config.mirror) {
        const safe = stripTerminalQueriesFromMirror(data);
        if (safe.length > 0) process.stdout.write(safe);
      }
      if (this.historyLogStream) this.historyLogStream.write(data);
      this.appendRawHistory(data);
      this.term.write(data, () => {
        // Buffer now reflects this chunk. Debounce-schedule screen-changed.
        this.scheduleChange();
      });
      this.emit("data", data);
    });

    // Reverse direction: forward xterm-synthesized responses back into the PTY
    // so TUI agents that block on terminal-capability queries can proceed.
    //
    // Why this is the right wiring (not an interceptor): xterm.headless's
    // parser already implements DSR (`\x1b[6n` cursor position),
    // Primary/Secondary Device Attributes (`\x1b[c` / `\x1b[>c`), and similar
    // query handlers. Each emits its synthesized response through
    // `term.onData` — the doc on `IEvent<string>` (xterm-headless.d.ts)
    // explicitly says "in a typical setup, this should be passed on to the
    // backing pty". Without this listener, those responses are discarded.
    //
    // Why we need it now (codex 0.128.0 trigger):
    //   - claude / kimi tolerate missing query responses (Ink CLI framework
    //     is forgiving — claude continues rendering, kimi just warns).
    //   - codex 0.128.0 (ratatui-style) sends `\x1b[6n` and OSC 10/11 at TUI
    //     startup and BLOCKS waiting for responses. Without this listener,
    //     codex hangs after the banner — see
    //     `update/spike-验证结果.md` 坑 4 (status updated 2026-05-05).
    //
    // Mirror-mode "double response" defense: even with this term.onData
    // wiring, an interactive run mirrors PTY output to the user's real
    // terminal (process.stdout), which would also auto-respond to any
    // queries it sees. Those second responses come back via process.stdin
    // (or controlling-tty fallback) and pollute the TUI's input field.
    // We solve that by stripping queries from the mirror BEFORE writing
    // (see stripTerminalQueriesFromMirror call above) so the real terminal
    // never sees the queries — only xterm.headless does, and only it
    // responds. One query → exactly one response.
    this.term.onData((response: string) => {
      try {
        this.proc.write(response);
      } catch {
        // PTY closed mid-response — harmless, the TUI is gone anyway.
      }
    });

    this.proc.onExit(({ exitCode, signal }: { exitCode: number; signal?: number }) => {
      this.exited = true;
      this.exitCode = exitCode;
      this.exitSignal = signal;
      this.flushChange();
      if (this.historyLogStream) {
        const stream = this.historyLogStream;
        this.historyLogStream = null;
        stream.end();
      }
      this.emit("exit", { exitCode, signal });
    });
  }

  /** FIFO ring buffer: append raw bytes, drop oldest when over maxHistoryBytes. */
  private appendRawHistory(data: string): void {
    const buf = Buffer.from(data, "utf8");
    this.rawChunks.push(buf);
    this.rawBytes += buf.length;
    while (this.rawBytes > this.config.maxHistoryBytes && this.rawChunks.length > 0) {
      const dropped = this.rawChunks.shift()!;
      this.rawBytes -= dropped.length;
      this.rawTruncated = true;
    }
  }

  /** Schedule a debounced "screen-changed" emission. */
  private scheduleChange(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.emit("screen-changed");
    }, this.config.changeDebounceMs);
  }

  private flushChange(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
      this.emit("screen-changed");
    }
  }

  // ─── synchronous reads ──────────────────────────────────────────────────────

  /**
   * Read the current screen.
   *
   *   range: "viewport"           — only visible rows (TUI / Claude / Kimi)
   *   range: "all"                — full buffer including scrollback
   *   range: { lastLines: N }     — last N rows (default for single-shot output)
   *
   * Default: { lastLines: 200 } — covers most command output, bounded for Agent context.
   */
  snapshot(opts: { range?: SnapshotRange } = {}): ScreenRead {
    return readScreenAnsi(this.term, opts.range);
  }

  stats(): { rawBytes: number; dataChunks: number; exited: boolean; exitCode: number | null } {
    return { rawBytes: this.rawBytes, dataChunks: this.dataChunks, exited: this.exited, exitCode: this.exitCode };
  }

  // ─── raw history (full PTY byte stream since session start) ─────────────────

  /** All raw PTY bytes accumulated so far (ANSI included). FIFO-truncated to
   *  maxHistoryBytes. Use `getHistoryStats().truncated` to detect drop. */
  getRawHistoryBytes(): Buffer {
    return Buffer.concat(this.rawChunks);
  }

  /** Same as getRawHistoryBytes() but as a UTF-8 string (ANSI escape sequences
   *  preserved verbatim). */
  getRawHistory(): string {
    return this.getRawHistoryBytes().toString("utf8");
  }

  /** ANSI-stripped history — pure visible text, suitable for grep / log review.
   *  Note: when ring-buffer truncation has dropped the head, the remaining
   *  bytes may begin mid-escape; the regex tolerates this. */
  getCleanHistory(): string {
    return stripAnsi(this.getRawHistory());
  }

  /** Stats about the in-memory history. `path` is non-null only when the
   *  caller set historyLogPath (or display=open-terminal auto-created one). */
  getHistoryStats(): { bytes: number; chunks: number; truncated: boolean; path: string | null } {
    return {
      bytes: this.rawBytes,
      chunks: this.dataChunks,
      truncated: this.rawTruncated,
      path: this.config.historyLogPath,
    };
  }

  // ─── input ──────────────────────────────────────────────────────────────────

  write(text: string): void {
    if (this.exited) throw new Error("Session has exited");
    this.proc.write(text);
  }

  sendKey(key: TerminalKey): void {
    if (this.exited) throw new Error("Session has exited");
    this.proc.write(KEY_SEQUENCES[key]);
  }

  resize(rows: number, cols: number): void {
    if (this.exited) return;
    this.proc.resize(cols, rows);
    this.term.resize(cols, rows);
  }

  // ─── event-driven waits ─────────────────────────────────────────────────────

  /**
   * Wait for the visible screen text to match the regex.
   * Returns immediately if already matching.
   * Pure event-driven: listens for screen-changed, no polling.
   */
  waitForRegex(re: RegExp, opts: WaitOptions = {}): Promise<{ snapshot: ScreenRead; match: RegExpMatchArray }> {
    const timeoutMs = opts.timeoutMs ?? DEFAULTS.expectTimeoutMs;

    // Fast path: already matching.
    {
      const snap = this.snapshot();
      const m = snap.plainText.match(re);
      if (m) return Promise.resolve({ snapshot: snap, match: m });
    }

    return new Promise((resolve, reject) => {
      const onChanged = () => {
        const snap = this.snapshot();
        const m = snap.plainText.match(re);
        if (m) {
          cleanup();
          resolve({ snapshot: snap, match: m });
        }
      };
      const onExit = () => {
        // Final shot before giving up.
        const snap = this.snapshot();
        const m = snap.plainText.match(re);
        if (m) { cleanup(); resolve({ snapshot: snap, match: m }); return; }
        cleanup();
        reject(new TerminalTimeoutError(
          "expect-regex-after-exit",
          snap,
          `process exited before regex ${re} matched`,
        ));
      };
      const deadline = setTimeout(() => {
        cleanup();
        const snap = this.snapshot();
        reject(new TerminalTimeoutError(
          "expect-regex-timeout",
          snap,
          `regex ${re} not seen within ${timeoutMs}ms`,
        ));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(deadline);
        this.off("screen-changed", onChanged);
        this.off("exit", onExit);
      };
      this.on("screen-changed", onChanged);
      this.on("exit", onExit);
    });
  }

  waitForText(text: string, opts?: WaitOptions): Promise<{ snapshot: ScreenRead }> {
    return this.waitForRegex(new RegExp(escapeRegex(text)), opts).then(({ snapshot }) => ({ snapshot }));
  }

  /**
   * Wait until the screen has been quiet for stabilityMs (no screen-changed
   * events). Pure event-driven; resets on each new event.
   */
  waitForIdle(opts: WaitForIdleOptions = {}): Promise<ScreenRead> {
    const stabilityMs = opts.stabilityMs ?? DEFAULTS.idleStabilityMs;
    const maxMs = opts.timeoutMs ?? DEFAULTS.idleMaxMs;
    const requireFirstEvent = opts.requireFirstEvent ?? false;

    return new Promise((resolve, reject) => {
      let stabilityTimer: NodeJS.Timeout | null = null;

      const arm = () => {
        if (stabilityTimer) clearTimeout(stabilityTimer);
        stabilityTimer = setTimeout(() => {
          cleanup();
          resolve(this.snapshot());
        }, stabilityMs);
      };

      const onChanged = () => arm();
      const onExit = () => { cleanup(); resolve(this.snapshot()); };

      const deadline = setTimeout(() => {
        cleanup();
        reject(new TerminalTimeoutError(
          "idle-timeout",
          this.snapshot(),
          `screen never went idle for ${stabilityMs}ms within ${maxMs}ms`,
        ));
      }, maxMs);

      const cleanup = () => {
        if (stabilityTimer) clearTimeout(stabilityTimer);
        clearTimeout(deadline);
        this.off("screen-changed", onChanged);
        this.off("exit", onExit);
      };

      this.on("screen-changed", onChanged);
      this.on("exit", onExit);
      // Without requireFirstEvent: arm immediately (1.5s of nothing → idle).
      // With requireFirstEvent: wait for first event then arm (avoids
      // immediate resolve on empty/freshly-spawned screen).
      if (!requireFirstEvent) arm();
    });
  }

  /**
   * Wait until the screen changes ONCE (single screen-changed event).
   * Designed for "I just pressed an arrow key, wait for the TUI to redraw
   * the highlight, then check state." Resolves on first event after the
   * call, ignores history. Returns the screen *after* the change.
   * Pure event-driven, no polling.
   */
  waitForChange(opts: WaitOptions = {}): Promise<ScreenRead> {
    const timeoutMs = opts.timeoutMs ?? DEFAULTS.expectTimeoutMs;
    return new Promise((resolve, reject) => {
      const onChanged = () => { cleanup(); resolve(this.snapshot()); };
      const onExit = () => { cleanup(); resolve(this.snapshot()); };
      const deadline = setTimeout(() => {
        cleanup();
        reject(new TerminalTimeoutError(
          "wait-change-timeout",
          this.snapshot(),
          `screen never changed within ${timeoutMs}ms`,
        ));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(deadline);
        this.off("screen-changed", onChanged);
        this.off("exit", onExit);
      };
      this.on("screen-changed", onChanged);
      this.on("exit", onExit);
    });
  }

  /**
   * Wait until the underlying process exits naturally.
   * Resolves immediately if already exited.
   */
  waitForExit(opts: WaitOptions = {}): Promise<{ exitCode: number | null; signal: number | undefined }> {
    if (this.exited) return Promise.resolve({ exitCode: this.exitCode, signal: this.exitSignal });
    const timeoutMs = opts.timeoutMs ?? DEFAULTS.idleMaxMs;
    return new Promise((resolve, reject) => {
      const onExit = ({ exitCode, signal }: { exitCode: number | null; signal: number | undefined }) => {
        cleanup();
        resolve({ exitCode, signal });
      };
      const deadline = setTimeout(() => {
        cleanup();
        reject(new TerminalTimeoutError(
          "wait-exit-timeout",
          this.snapshot(),
          `process did not exit within ${timeoutMs}ms`,
        ));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(deadline);
        this.off("exit", onExit);
      };
      this.on("exit", onExit);
    });
  }

  /**
   * Wait for the TUI's input prompt to be ready.
   * Two phases (both event-driven):
   *   1. waitForRegex(readyPattern) — prompt indicator visible
   *   2. waitForIdle(postReadyStabilityMs) — TUI fully stopped drawing
   */
  async waitForReady(opts: WaitForReadyOptions = {}): Promise<ScreenRead> {
    const timeoutMs = opts.timeoutMs ?? DEFAULTS.readyTimeoutMs;
    const readyPattern = opts.readyPattern ?? DEFAULTS.readyPattern;
    const postReadyStabilityMs = opts.postReadyStabilityMs ?? DEFAULTS.postReadyStabilityMs;

    const start = Date.now();
    await this.waitForRegex(readyPattern, { timeoutMs });
    const elapsed = Date.now() - start;
    const remaining = Math.max(timeoutMs - elapsed, postReadyStabilityMs * 2);

    return this.waitForIdle({ stabilityMs: postReadyStabilityMs, timeoutMs: remaining });
  }

  // ─── lifecycle ──────────────────────────────────────────────────────────────

  async close(opts: { kill?: boolean; gracefulTimeoutMs?: number } = {}): Promise<{ exitCode: number | null }> {
    const { kill = true, gracefulTimeoutMs = 1500 } = opts;
    if (this.exited) return { exitCode: this.exitCode };

    if (kill) {
      try { this.proc.kill("SIGTERM"); } catch { /* already gone */ }
    }

    // Escalation ladder: SIGTERM → wait gracefulTimeoutMs → SIGKILL → wait
    // 500ms more → force-resolve. Why escalate: codex 0.128.0 (and other
    // ratatui-style TUIs) busy-loop on PTY EIO when the master end closes —
    // they don't respond to SIGTERM and stay at 100% CPU. Without SIGKILL
    // here, repeated `kill $SPIKE_PID` test runs accumulate stuck codex
    // orphans. SIGKILL is unblockable and guarantees the child dies.
    // See update/spike-验证结果.md "进程清理(orphan TUI cleanup)" section.
    const SIGKILL_GRACE_MS = 500;
    return new Promise((resolve) => {
      const sigkillTimer = setTimeout(() => {
        // SIGTERM grace expired — escalate. If child already gone, kill is no-op.
        try { this.proc.kill("SIGKILL"); } catch { /* already gone */ }
      }, gracefulTimeoutMs);
      const finalTimer = setTimeout(() => {
        // SIGKILL also didn't fire onExit (extremely unusual — kernel issue).
        // Force-resolve so caller isn't stuck. The dangling child is reaped
        // by the kernel later.
        resolve({ exitCode: this.exitCode });
      }, gracefulTimeoutMs + SIGKILL_GRACE_MS);
      this.once("exit", ({ exitCode }) => {
        clearTimeout(sigkillTimer);
        clearTimeout(finalTimer);
        resolve({ exitCode: exitCode ?? null });
      });
    });
  }
}

// ─── factory ──────────────────────────────────────────────────────────────────

export async function startSession(config: SessionConfig): Promise<Session> {
  const cfg = {
    command: config.command,
    args: config.args ?? [],
    rows: config.rows ?? DEFAULTS.rows,
    cols: config.cols ?? DEFAULTS.cols,
    cwd: config.cwd ?? process.cwd(),
    env: config.env ?? {},
    loginShell: config.loginShell ?? DEFAULTS.loginShell,
    changeDebounceMs: config.changeDebounceMs ?? DEFAULTS.changeDebounceMs,
    mirror: config.mirror ?? false,
  };

  const display = resolveDisplay(config.display);
  // historyLogPath: caller-explicit always wins; if display=open-terminal and
  // caller didn't set, auto-create a temp file (viewer needs a real path to tail).
  let historyLogPath: string | null = config.historyLogPath ?? null;
  let viewer: ViewerHandle | null = null;
  if (display === "open-terminal") {
    const resolvedPath: string = historyLogPath ?? defaultHistoryLogPath(cfg.command);
    historyLogPath = resolvedPath;
    const title = config.viewerWindowTitle ?? `ttm: ${path.basename(cfg.command)} (pid pending)`;
    viewer = openLiveViewer({ logPath: resolvedPath, title });
    if (!viewer) {
      // Fallback: still keep the log file (caller can manually `tail -f` later)
      // but warn that no GUI viewer was opened.
      process.stderr.write(`[session] display=open-terminal requested but viewer unavailable; continuing headless. Log: ${resolvedPath}\n`);
    }
  }

  const term = new Terminal({ cols: cfg.cols, rows: cfg.rows, allowProposedApi: true });

  // Inherit host env unless caller specifies all of theirs (TODO: V1 sandbox
  // adds env_inheritance modes; this is the simple inherit-all behavior used
  // by the spike tools).
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") env[k] = v;
  }
  env.TERM = "xterm-256color";
  for (const [k, v] of Object.entries(cfg.env)) env[k] = v;

  const wrapped = wrapWithLoginShell({
    command: cfg.command,
    args: cfg.args,
    loginShell: cfg.loginShell,
  });

  const proc = pty.spawn(wrapped.command, wrapped.args, {
    name: "xterm-256color",
    cols: cfg.cols,
    rows: cfg.rows,
    cwd: cfg.cwd,
    env,
  });

  const session = new Session(config, term, proc, {
    display,
    historyLogPath,
    viewerWindowTitle: config.viewerWindowTitle ?? `ttm: ${path.basename(cfg.command)} pid=${proc.pid}`,
    viewer,
  });

  // Register for process-level cleanup (round 9 review fix: previously the
  // liveSessions Set was never populated, making the SIGINT/SIGTERM hook a no-op).
  liveSessions.add(session);
  session.once("exit", () => { liveSessions.delete(session); });
  return session;
}

function resolveDisplay(req: SessionConfig["display"]): "headless" | "open-terminal" {
  if (req === "headless" || req === undefined) return "headless";
  if (req === "open-terminal") return "open-terminal";
  // auto: open-terminal if env looks like a desktop session, else headless
  if (process.env.CI === "true") return "headless";
  if (process.env.GITHUB_ACTIONS) return "headless";
  if (process.env.SSH_CONNECTION || process.env.SSH_CLIENT) return "headless";
  if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return "headless";
  return "open-terminal";
}

function defaultHistoryLogPath(command: string): string {
  const base = `ttm-${path.basename(command)}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.log`;
  return path.join(os.tmpdir(), base);
}

// ─── high-level helper: askClaude ─────────────────────────────────────────────

export interface AskClaudeOptions {
  prompt: string;
  command?: string;             // default "claude"
  args?: string[];
  rows?: number;
  cols?: number;
  loginShell?: boolean;          // default true
  /** Total budget for the whole interaction (ready + reply + extract). */
  timeoutMs?: number;            // default 180_000
  /** How long the screen must be quiet before reply is considered complete. */
  replyStabilityMs?: number;     // default 1500
  /** Return ANSI form of reply too. */
  includeAnsi?: boolean;
  /** Verbose progress to stderr. */
  verbose?: boolean;
  /**
   * Live preview mode.
   *   "headless"      — default (correct for CI / vitest / jest / programmatic use)
   *   "open-terminal" — open Terminal.app window mirroring the session in real time
   *   "auto"          — desktop env → open-terminal, CI / SSH → headless
   */
  display?: "headless" | "open-terminal" | "auto";
  historyLogPath?: string;
  viewerWindowTitle?: string;
}

export interface AskClaudeResult {
  reply: string;
  ansiReply?: string;
  exitCode: number | null;
  ok: boolean;
  reason?: string;
}

export async function askClaude(opts: AskClaudeOptions): Promise<AskClaudeResult> {
  const log = (...a: unknown[]) => { if (opts.verbose) process.stderr.write(`[ask] ${a.map(String).join(" ")}\n`); };
  const totalTimeout = opts.timeoutMs ?? 180_000;
  const replyStability = opts.replyStabilityMs ?? 1500;

  const session = await startSession({
    command: opts.command ?? "claude",
    args: opts.args,
    rows: opts.rows,
    cols: opts.cols,
    loginShell: opts.loginShell ?? true,
    display: opts.display,
    historyLogPath: opts.historyLogPath,
    viewerWindowTitle: opts.viewerWindowTitle,
  });

  log(`pid=${session.pid}${session.viewer ? ` viewer=open log=${session.config.historyLogPath}` : ""}`);

  try {
    log(`waitForReady(❯)`);
    await session.waitForReady({ readyPattern: /❯\s/, timeoutMs: 30_000 });
    log(`ready`);

    log(`writing prompt (${opts.prompt.length} chars)`);
    session.write(opts.prompt);
    // Tiny delay so Ink doesn't treat it as paste mode (spike lesson).
    await delay(150);
    session.sendKey("enter");

    log(`waitForRegex(/⏺/)`);
    await session.waitForRegex(/⏺/, { timeoutMs: totalTimeout });
    log(`reply started`);

    // Reply done = either "✻ Crunched" appeared, or screen is idle for
    // replyStability ms. Whichever comes first.
    log(`waitForIdle(${replyStability}ms) | or ✻ Crunched`);
    const idleP = session.waitForIdle({ stabilityMs: replyStability, timeoutMs: totalTimeout });
    const crunchedP = session.waitForRegex(/✻\s+Crunched for/, { timeoutMs: totalTimeout })
      .then(() => session.snapshot());
    const finalSnap = await Promise.race([idleP, crunchedP]);
    log(`reply complete`);

    const reply = extractClaudeReply(finalSnap);
    if (!reply) {
      return { reply: "", exitCode: session.stats().exitCode, ok: false, reason: "no ⏺ marker found in final screen" };
    }
    return {
      reply: reply.plain,
      ansiReply: opts.includeAnsi ? reply.ansi : undefined,
      exitCode: session.stats().exitCode,
      ok: true,
    };
  } catch (err) {
    if (err instanceof TerminalTimeoutError) {
      const reply = extractClaudeReply(err.snapshot);
      return {
        reply: reply?.plain ?? "",
        ansiReply: opts.includeAnsi ? reply?.ansi : undefined,
        exitCode: session.stats().exitCode,
        ok: false,
        reason: `${err.kind}: ${err.message}`,
      };
    }
    throw err;
  } finally {
    await session.close();
  }
}

// ─── reply extraction (carved out of ask-claude.ts, keep paired plain+ansi) ──

export function extractClaudeReply(s: ScreenRead): { plain: string; ansi: string } | null {
  const collectedPlain: string[] = [];
  const collectedAnsi: string[] = [];
  let inReply = false;

  for (let idx = 0; idx < s.plainLines.length; idx++) {
    const line = s.plainLines[idx];
    const aLine = s.ansiLines[idx] ?? "";
    const trimmedStart = line.replace(/^\s+/, "");

    if (trimmedStart.startsWith("⏺ ")) {
      inReply = true;
      const at = line.indexOf("⏺ ");
      collectedPlain.push(line.slice(at + 2).trimEnd());
      collectedAnsi.push(aLine);
      continue;
    }

    if (!inReply) continue;

    const t = line.trim();
    if (t.startsWith("✻ ") || t.startsWith("✳ ")) break;
    if (t.startsWith("❯")) break;
    if (line.includes("⏵⏵")) break;
    if (/^─{20,}/.test(t)) break;

    collectedPlain.push(line.trimEnd());
    collectedAnsi.push(aLine);
  }

  if (collectedPlain.length === 0) return null;
  while (collectedPlain.length && collectedPlain[0].trim() === "") {
    collectedPlain.shift();
    collectedAnsi.shift();
  }
  while (collectedPlain.length && collectedPlain[collectedPlain.length - 1].trim() === "") {
    collectedPlain.pop();
    collectedAnsi.pop();
  }
  return { plain: collectedPlain.join("\n"), ansi: collectedAnsi.join("\n") };
}

// ─── utilities ────────────────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Strip CSI / OSC ANSI escape sequences for clean-history. When the ring
// buffer has dropped the head, bytes may start mid-sequence; the patterns
// gracefully ignore unmatched fragments.
const ANSI_CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;          // \x1b[<params><intermediate><final>
const ANSI_OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g; // \x1b]...\x07 or ...\x1b\\
const ANSI_OTHER = /\x1b[@-Z\\-_]/g;                   // ESC + single-char (e.g. \x1bD, \x1bE)
function stripAnsi(s: string): string {
  return s.replace(ANSI_CSI, "").replace(ANSI_OSC, "").replace(ANSI_OTHER, "");
}

// Process-level cleanup so orphan TUI processes don't outlive the host script.
//
// Why this matters: codex 0.128.0 (and other ratatui-style TUIs) busy-loop
// on PTY EIO when the master closes — they ignore SIGTERM and stay at 100%
// CPU. Without escalation here, killing the spike (e.g. `kill $SPIKE_PID`
// from outer shell, or kernel SIGHUP when npm parent dies) leaves stuck
// codex orphans. We:
//   1. Hook SIGINT / SIGTERM / SIGHUP / beforeExit. SIGHUP is the kernel's
//      "your parent died, you're orphaned" signal — without a handler, node's
//      default would terminate immediately and skip cleanup.
//   2. Send SIGTERM first (lets well-behaved children clean up), wait a
//      short grace, then SIGKILL any survivor before exiting. SIGKILL is
//      unblockable so this guarantees no 100% CPU orphans.
//   3. beforeExit (graceful node exit, no signal) runs SIGTERM+SIGKILL
//      back-to-back since we can't synchronously delay.
const liveSessions = new Set<Session>();
const installed = (() => {
  const SIGKILL_GRACE_MS = 500;
  const sigkillStragglers = () => {
    for (const s of liveSessions) {
      try { s.proc.kill("SIGKILL"); } catch { /* ignore */ }
    }
  };
  const sigtermAll = () => {
    for (const s of liveSessions) {
      try { s.proc.kill("SIGTERM"); } catch { /* ignore */ }
    }
  };
  const handleSignal = (exitCode: number) => {
    sigtermAll();
    // Defer process.exit so SIGKILL gets a chance to fire after grace period.
    setTimeout(() => {
      sigkillStragglers();
      process.exit(exitCode);
    }, SIGKILL_GRACE_MS);
  };
  process.on("SIGINT",  () => handleSignal(130));
  process.on("SIGTERM", () => handleSignal(143));
  // SIGHUP fires when the parent (npm/shell) dies and orphans us. Default
  // node behavior is silent termination — we add a handler to ensure
  // cleanup runs first.
  process.on("SIGHUP",  () => handleSignal(129));
  // beforeExit is sync — fire SIGTERM and SIGKILL together. Children that
  // can clean up on SIGTERM in microseconds get the chance; the rest die.
  process.on("beforeExit", () => {
    sigtermAll();
    sigkillStragglers();
  });
  return true;
})();
void installed;
