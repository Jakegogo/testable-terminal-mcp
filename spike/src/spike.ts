/**
 * testable-terminal-mcp — research spike CLI.
 *
 * Thin wrapper over `lib/session.ts`. Now event-driven (no fixed dwell):
 *   - --ready-pattern + waitForReady (events) replaces --dwell
 *   - --expect / --expect-regex use lib waitForText/waitForRegex (events)
 *   - --interactive forwards your stdin to the TUI
 *
 * stdout: snapshot output
 * stderr: progress / status
 */

import { startSession, type Session, TerminalTimeoutError } from "./lib/session.js";

interface SpikeOptions {
  command: string;
  args: string[];
  prompt?: string;
  expectText?: string;
  expectRegex?: string;
  expectFlags: string;
  readyPattern?: string;
  readyFlags: string;
  waitReady: boolean;
  waitReadyTimeoutMs: number;
  expectTimeoutMs: number;
  postReadyStabilityMs: number;
  settledStabilityMs: number;
  promptToEnterDelayMs: number;
  interactive: boolean;
  mirror: boolean;
  rows: number;
  cols: number;
  loginShell: boolean;
  color: boolean;
  display: "headless" | "open-terminal" | "auto";
}

const DEFAULTS = {
  rows: 40,
  cols: 120,
  expectTimeoutMs: 60_000,
  waitReadyTimeoutMs: 30_000,
  postReadyStabilityMs: 600,
  settledStabilityMs: 1500,
  promptToEnterDelayMs: 150,
  readyPattern: "(?:❯|[#$%>]\\s)",
  readyFlags: "",
  expectFlags: "",
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function printSnapshot(label: string, session: Session, color: boolean): void {
  const s = session.snapshot();
  process.stderr.write(`\n========== SNAPSHOT: ${label} ==========\n`);
  process.stderr.write(`cursor: row=${s.cursor.row} col=${s.cursor.col} | rows=${session.term.rows} cols=${session.term.cols}${color ? " | color=on" : ""}\n`);
  process.stderr.write(`---\n`);
  process.stderr.write((color ? s.ansiText : s.plainText) + "\n");
  if (color) process.stderr.write("\x1b[0m");
  process.stderr.write(`========================================\n\n`);
}

async function runSpike(opts: SpikeOptions): Promise<number> {
  process.stderr.write(`[spike] spawning: ${opts.command} ${opts.args.join(" ")} (login-shell=${opts.loginShell}, mode=${opts.interactive ? "interactive" : "scripted"}, display=${opts.display})\n`);

  let session: Session;
  try {
    session = await startSession({
      command: opts.command,
      args: opts.args,
      rows: opts.rows,
      cols: opts.cols,
      loginShell: opts.loginShell,
      mirror: opts.mirror || opts.interactive,
      display: opts.display,
    });
  } catch (err) {
    process.stderr.write(`[spike] FAILED to spawn: ${(err as Error).message}\n`);
    return 2;
  }
  process.stderr.write(`[spike] pid=${session.pid}\n`);

  if (opts.interactive) return runInteractive(session, opts);
  return runScripted(session, opts);
}

async function runScripted(session: Session, opts: SpikeOptions): Promise<number> {
  // Phase 1: wait for first signal of "command produced something useful".
  // Race three conditions, first one wins:
  //   - exit       : process ended (single-shot like `aikey list`)
  //   - ready      : TUI prompt regex visible (interactive like `claude`)
  //   - settled    : screen had any data and then went quiet for 1500ms
  //                  (TUI without a traditional prompt, like `aikey use`)
  //
  // Replaces the old "wait-ready 30s timeout for everything" which made
  // single-shot commands seem hung for 30s. Now `aikey list` snaps as soon
  // as it exits (~50ms); `aikey use` snaps when its menu finishes drawing.
  if (opts.waitReady) {
    const re = new RegExp(opts.readyPattern ?? DEFAULTS.readyPattern, opts.readyFlags);
    process.stderr.write(`[spike] phase=wait-first-signal: race(exit | ready=${re} | settled ${opts.settledStabilityMs}ms) timeout=${opts.waitReadyTimeoutMs}ms\n`);

    let kind = "?";
    const exitP = session.waitForExit({ timeoutMs: opts.waitReadyTimeoutMs })
      .then((r) => { kind = `exit code=${r.exitCode}`; });
    const readyP = session.waitForReady({
      readyPattern: re,
      timeoutMs: opts.waitReadyTimeoutMs,
      postReadyStabilityMs: opts.postReadyStabilityMs,
    }).then(() => { kind = "ready"; });
    const settledP = session.waitForIdle({
      stabilityMs: opts.settledStabilityMs,
      timeoutMs: opts.waitReadyTimeoutMs,
      requireFirstEvent: true,
    }).then(() => { kind = "settled"; });

    try {
      await Promise.any([exitP, readyP, settledP]);
      process.stderr.write(`[spike] first-signal: ${kind}\n`);
    } catch (err) {
      // AggregateError when all 3 reject (true "nothing happened" case).
      process.stderr.write(`[spike] WAIT-READY: all 3 signals timed out within ${opts.waitReadyTimeoutMs}ms\n`);
      printSnapshot("on-wait-ready-timeout", session, opts.color);
      await session.close();
      return 1;
    }
  }

  printSnapshot("after-ready", session, opts.color);

  // If the child already exited during phase 1 (e.g. command not found, or
  // shim that runs `aikey preflight` and fails immediately), skip
  // write/expect — they would throw "Session has exited" and get swallowed
  // by the global catch as exit 0 (false pass). Inherit child exit code.
  if (session.stats().exited) {
    const stat = session.stats();
    process.stderr.write(`[spike] child exited during wait phase (code=${stat.exitCode}); skipping write/expect\n`);
    printSnapshot("final", session, opts.color);
    process.stderr.write(`[spike] done: exit=${stat.exitCode} bytes=${stat.rawBytes} chunks=${stat.dataChunks}\n`);
    return stat.exitCode === null || stat.exitCode === 0 ? 1 : stat.exitCode;
  }

  // Phase 2: send prompt(text + Enter, separated to avoid Ink paste mode).
  if (opts.prompt) {
    process.stderr.write(`[spike] phase=write, prompt=${JSON.stringify(opts.prompt)}\n`);
    session.write(opts.prompt);
    await sleep(opts.promptToEnterDelayMs);
    process.stderr.write(`[spike] phase=submit, sending Enter\n`);
    session.sendKey("enter");
  }

  // Phase 3: expect (event-driven; no polling).
  let exitCode = 0;
  if (opts.expectText || opts.expectRegex) {
    const re = opts.expectRegex
      ? new RegExp(opts.expectRegex, opts.expectFlags || undefined)
      : new RegExp(escapeRegex(opts.expectText!));
    process.stderr.write(`[spike] phase=expect, re=${re}, timeout=${opts.expectTimeoutMs}ms\n`);
    try {
      await session.waitForRegex(re, { timeoutMs: opts.expectTimeoutMs });
      const stat = session.stats();
      process.stderr.write(`[spike] MATCH bytes=${stat.rawBytes} chunks=${stat.dataChunks}\n`);
      printSnapshot("matched", session, opts.color);
    } catch (err) {
      if (err instanceof TerminalTimeoutError) {
        const stat = session.stats();
        process.stderr.write(`[spike] TIMEOUT (${err.kind}) bytes=${stat.rawBytes} chunks=${stat.dataChunks}\n`);
        printSnapshot("on-timeout", session, opts.color);
        exitCode = 1;
      } else throw err;
    }
  } else {
    // No --expect: print final snapshot. Inherit child process exit code so
    // a non-zero subprocess exit propagates to the spike caller (round 9
    // review fix: previously we always returned 0 here, masking failures).
    printSnapshot("final", session, opts.color);
  }

  await session.close();
  const stat = session.stats();
  process.stderr.write(`[spike] done: exit=${stat.exitCode} bytes=${stat.rawBytes} chunks=${stat.dataChunks}\n`);

  // Reflect child's exit code when no --expect was given.
  if (!opts.expectText && !opts.expectRegex && exitCode === 0) {
    if (stat.exitCode !== null && stat.exitCode !== 0) exitCode = stat.exitCode;
  }
  return exitCode;
}

async function runInteractive(session: Session, opts: SpikeOptions): Promise<number> {
  process.stderr.write(`[spike] interactive mode. Hotkeys (raw stdin):\n`);
  process.stderr.write(`[spike]   Ctrl+]   show snapshot\n`);
  process.stderr.write(`[spike]   Ctrl+\\   kill child & exit\n\n`);

  if (process.stdin.isTTY && process.stdin.setRawMode) process.stdin.setRawMode(true);
  process.stdin.resume();

  process.stdin.on("data", (chunk: Buffer) => {
    if (chunk.length === 1 && chunk[0] === 0x1d) { printSnapshot("manual", session, opts.color); return; }
    if (chunk.length === 1 && chunk[0] === 0x1c) { void session.close(); process.exit(0); }
    session.write(chunk.toString("utf8"));
  });

  if (process.stdout.isTTY) {
    process.stdout.on("resize", () => {
      const cols = process.stdout.columns ?? opts.cols;
      const rows = process.stdout.rows ?? opts.rows;
      try { session.resize(rows, cols); } catch { /* ignore */ }
    });
  }

  return new Promise((resolve) => {
    session.on("exit", () => {
      printSnapshot("on-exit", session, opts.color);
      resolve(0);
    });
  });
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseArgs(argv: string[]): SpikeOptions {
  const args = argv.slice(2);
  const opts: SpikeOptions = {
    command: "",
    args: [],
    expectFlags: DEFAULTS.expectFlags,
    readyPattern: DEFAULTS.readyPattern,
    readyFlags: DEFAULTS.readyFlags,
    waitReady: true,
    waitReadyTimeoutMs: DEFAULTS.waitReadyTimeoutMs,
    expectTimeoutMs: DEFAULTS.expectTimeoutMs,
    postReadyStabilityMs: DEFAULTS.postReadyStabilityMs,
    settledStabilityMs: DEFAULTS.settledStabilityMs,
    promptToEnterDelayMs: DEFAULTS.promptToEnterDelayMs,
    interactive: false,
    mirror: false,
    rows: DEFAULTS.rows,
    cols: DEFAULTS.cols,
    loginShell: false,
    color: false,
    display: "headless",
  };

  let i = 0;
  while (i < args.length) {
    const a = args[i];
    if (a === "--interactive" || a === "-i") { opts.interactive = true; i++; }
    else if (a === "--mirror") { opts.mirror = true; i++; }
    else if (a === "--prompt") { opts.prompt = args[++i]; i++; }
    else if (a === "--expect") { opts.expectText = args[++i]; i++; }
    else if (a === "--expect-regex") { opts.expectRegex = args[++i]; i++; }
    else if (a === "--expect-flags") { opts.expectFlags = args[++i]; i++; }
    else if (a === "--timeout") { opts.expectTimeoutMs = parseInt(args[++i], 10); i++; }
    else if (a === "--rows") { opts.rows = parseInt(args[++i], 10); i++; }
    else if (a === "--cols") { opts.cols = parseInt(args[++i], 10); i++; }
    else if (a === "--ready-pattern") { opts.readyPattern = args[++i]; i++; }
    else if (a === "--ready-flags") { opts.readyFlags = args[++i]; i++; }
    else if (a === "--ready-timeout") { opts.waitReadyTimeoutMs = parseInt(args[++i], 10); i++; }
    else if (a === "--no-wait-ready") { opts.waitReady = false; i++; }
    else if (a === "--post-ready-stability") { opts.postReadyStabilityMs = parseInt(args[++i], 10); i++; }
    else if (a === "--settled-stability") { opts.settledStabilityMs = parseInt(args[++i], 10); i++; }
    else if (a === "--prompt-enter-delay") { opts.promptToEnterDelayMs = parseInt(args[++i], 10); i++; }
    else if (a === "--login-shell") { opts.loginShell = true; i++; }
    else if (a === "--no-login-shell") { opts.loginShell = false; i++; }
    else if (a === "--color") { opts.color = true; i++; }
    else if (a === "--no-color") { opts.color = false; i++; }
    else if (a === "--display") {
      const v = args[++i];
      if (v !== "headless" && v !== "open-terminal" && v !== "auto") {
        process.stderr.write(`error: --display must be headless | open-terminal | auto, got ${v}\n`);
        process.exit(1);
      }
      opts.display = v; i++;
    }
    else if (a === "--open-terminal") { opts.display = "open-terminal"; i++; }
    else if (a === "--help" || a === "-h") { printUsage(); process.exit(0); }
    else if (!opts.command) { opts.command = a; i++; }
    else { opts.args.push(a); i++; }
  }

  if (!opts.command) { printUsage(); process.exit(1); }
  return opts;
}

function printUsage(): void {
  process.stderr.write(`testable-terminal-mcp spike

Usage:
  tsx src/spike.ts <command> [args...] [options]

Options:
  --prompt TEXT             Send TEXT after ready, then Enter (split to avoid Ink paste mode)
  --expect TEXT             Wait until screen contains TEXT
  --expect-regex PATTERN    Wait until screen matches regex
  --expect-flags FLAGS      Regex flags (e.g. "i", "m")
  --timeout MS              Expect timeout (default ${DEFAULTS.expectTimeoutMs})
  --ready-pattern PATTERN   Regex for "TUI ready" detection (default tries common prompts)
  --ready-flags FLAGS       Regex flags for ready-pattern (default "${DEFAULTS.readyFlags}")
  --ready-timeout MS        Wait-ready timeout (default ${DEFAULTS.waitReadyTimeoutMs})
  --no-wait-ready           Skip wait-ready phase
  --post-ready-stability MS Quiet window after ready signal (default ${DEFAULTS.postReadyStabilityMs})
  --settled-stability MS    Race fallback: idle-after-first-event triggers if screen quiet for this long (default ${DEFAULTS.settledStabilityMs}; bump to 3000+ for slow-loading TUIs like codex)
  --prompt-enter-delay MS   Sleep between writing prompt text and sending Enter (default ${DEFAULTS.promptToEnterDelayMs}; bump to 400-600 for Ratatui TUIs like codex if Enter gets eaten)
  --rows N / --cols N       Terminal size (default ${DEFAULTS.rows}x${DEFAULTS.cols})
  --mirror                  Mirror raw PTY output to your stdout
  --interactive,-i          Forward your stdin; Ctrl+] = snapshot, Ctrl+\\ = quit
  --login-shell             Run via $SHELL -ilc 'exec ...', loading ~/.zshrc / ~/.zprofile
  --no-login-shell          Disable login-shell wrapping (default)
  --color                   Render snapshot with full ANSI colors
  --no-color                Plain-text snapshot (default)
  --display MODE            headless | open-terminal | auto (default: headless)
  --open-terminal           Shorthand for --display open-terminal (opens real Terminal window mirroring PTY)

Examples:
  tsx src/spike.ts bash --prompt 'echo SPIKE_OK' --expect SPIKE_OK
  tsx src/spike.ts claude --login-shell --prompt 'reply with 15 only' --expect 15
  tsx src/spike.ts kimi -i --login-shell
`);
}

runSpike(parseArgs(process.argv)).then(
  (code) => process.exit(code),
  (err) => { process.stderr.write(`[spike] fatal: ${(err as Error).stack ?? err}\n`); process.exit(2); },
);
