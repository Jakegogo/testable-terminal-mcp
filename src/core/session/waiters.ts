/**
 * Event-driven wait helpers. Pure functions of (emitter, snapshot fn, opts).
 *
 * All 5 waiters listen for the session's `'screen-changed'` event (debounced
 * after PTY parser completion) and `'exit'` (final fallback). NO setInterval
 * polling — this is the round-1 lesson that keeps spike test latency at <100ms.
 *
 * Round 4: added waitForChange (single-event resolve) and waitForExit (process
 * natural-exit), motivated by aikey-use interactive testing.
 *
 * Round 5: waitForIdle gained `requireFirstEvent` so freshly-spawned empty
 * screens don't trigger immediate "idle" resolution (used in spike.ts race).
 *
 * Round 10: relies on the session emitting `'screen-changed'` from xterm's
 * write-completion callback, NOT immediately after onData — guarantees the
 * buffer reflects the chunk before any waiter reads it.
 */

import type { ScreenRead } from "../snapshot.js";
import { ErrorCode, TestableTerminalError } from "../errors.js";

// Event surface we depend on. Session implements this; tests can mock it.
export interface SessionEventSource {
  on(event: "screen-changed", listener: () => void): void;
  on(event: "exit", listener: () => void): void;
  off(event: "screen-changed", listener: () => void): void;
  off(event: "exit", listener: () => void): void;
}

export interface WaitContext {
  emitter: SessionEventSource;
  /** Reads the *current* screen at call time. Must be synchronous. */
  snapshot: () => ScreenRead;
  /** True if the underlying process has already exited. Used for fast-paths. */
  isExited: () => boolean;
}

export interface WaitOptions {
  timeoutMs?: number;
}

export interface WaitForRegexOptions extends WaitOptions {
  /** Default 60s. Bump for long agent operations. */
}

export interface WaitForIdleOptions extends WaitOptions {
  /** How long the screen must be quiet to count as "idle". Default 1500ms. */
  stabilityMs?: number;
  /**
   * Round 5: require at least one screen-changed event before arming the
   * stability timer. Use when racing against waitForReady on a freshly-
   * spawned session — without this, an empty screen at t=0 would resolve
   * idle immediately and make us miss the real "ready" signal.
   */
  requireFirstEvent?: boolean;
}

export interface WaitForReadyOptions extends WaitOptions {
  /** Regex marking "TUI input prompt is visible". */
  readyPattern: RegExp;
  /** After ready pattern seen, wait for screen to stabilize for this long. */
  postReadyStabilityMs?: number;
}

const DEFAULTS = {
  timeoutMs: 60_000,
  idleStabilityMs: 1_500,
  idleMaxMs: 180_000,
  postReadyStabilityMs: 600,
};

// ─── waitForRegex ────────────────────────────────────────────────────────────

export async function waitForRegex(
  ctx: WaitContext,
  re: RegExp,
  opts: WaitForRegexOptions = {},
): Promise<{ snapshot: ScreenRead; match: RegExpMatchArray }> {
  const timeoutMs = opts.timeoutMs ?? DEFAULTS.timeoutMs;

  // Fast-path: already matching at the call instant.
  {
    const snap = ctx.snapshot();
    const m = snap.plainText.match(re);
    if (m) return { snapshot: snap, match: m };
  }

  return new Promise((resolve, reject) => {
    const onChanged = (): void => {
      const snap = ctx.snapshot();
      const m = snap.plainText.match(re);
      if (m) {
        cleanup();
        resolve({ snapshot: snap, match: m });
      }
    };
    const onExit = (): void => {
      // Process exited — one final shot before giving up. Catches the case
      // where output races exit (single-shot commands like `aikey list`).
      const snap = ctx.snapshot();
      const m = snap.plainText.match(re);
      if (m) { cleanup(); resolve({ snapshot: snap, match: m }); return; }
      cleanup();
      reject(new TestableTerminalError(
        ErrorCode.EXPECT_TIMEOUT,
        `process exited before regex ${re} matched`,
        { snapshot: snap, kind: "expect-regex-after-exit" },
      ));
    };
    const deadline = setTimeout(() => {
      cleanup();
      const snap = ctx.snapshot();
      reject(new TestableTerminalError(
        ErrorCode.EXPECT_TIMEOUT,
        `regex ${re} not seen within ${timeoutMs}ms`,
        { snapshot: snap, kind: "expect-regex-timeout" },
      ));
    }, timeoutMs);
    const cleanup = (): void => {
      clearTimeout(deadline);
      ctx.emitter.off("screen-changed", onChanged);
      ctx.emitter.off("exit", onExit);
    };
    ctx.emitter.on("screen-changed", onChanged);
    ctx.emitter.on("exit", onExit);
  });
}

// ─── waitForText (regex helper) ──────────────────────────────────────────────

export async function waitForText(
  ctx: WaitContext,
  text: string,
  opts: WaitOptions = {},
): Promise<{ snapshot: ScreenRead }> {
  const re = new RegExp(escapeRegex(text));
  const { snapshot } = await waitForRegex(ctx, re, opts);
  return { snapshot };
}

// ─── waitForIdle ─────────────────────────────────────────────────────────────

export function waitForIdle(
  ctx: WaitContext,
  opts: WaitForIdleOptions = {},
): Promise<ScreenRead> {
  const stabilityMs = opts.stabilityMs ?? DEFAULTS.idleStabilityMs;
  const maxMs = opts.timeoutMs ?? DEFAULTS.idleMaxMs;
  const requireFirstEvent = opts.requireFirstEvent ?? false;

  return new Promise((resolve, reject) => {
    let stabilityTimer: NodeJS.Timeout | null = null;

    const arm = (): void => {
      if (stabilityTimer) clearTimeout(stabilityTimer);
      stabilityTimer = setTimeout(() => {
        cleanup();
        resolve(ctx.snapshot());
      }, stabilityMs);
    };

    const onChanged = (): void => arm();
    const onExit = (): void => { cleanup(); resolve(ctx.snapshot()); };

    const deadline = setTimeout(() => {
      cleanup();
      reject(new TestableTerminalError(
        ErrorCode.EXPECT_IDLE_TIMEOUT,
        `screen never went idle for ${stabilityMs}ms within ${maxMs}ms`,
        { snapshot: ctx.snapshot(), kind: "idle-timeout" },
      ));
    }, maxMs);

    const cleanup = (): void => {
      if (stabilityTimer) clearTimeout(stabilityTimer);
      clearTimeout(deadline);
      ctx.emitter.off("screen-changed", onChanged);
      ctx.emitter.off("exit", onExit);
    };

    ctx.emitter.on("screen-changed", onChanged);
    ctx.emitter.on("exit", onExit);
    // Round 5: when racing against ready/exit on a fresh session, only
    // arm after the first real event (avoids "empty buffer at t=0 looks idle").
    if (!requireFirstEvent) arm();
  });
}

// ─── waitForReady ────────────────────────────────────────────────────────────

export async function waitForReady(
  ctx: WaitContext,
  opts: WaitForReadyOptions,
): Promise<ScreenRead> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const postReadyStabilityMs = opts.postReadyStabilityMs ?? DEFAULTS.postReadyStabilityMs;

  const start = Date.now();
  await waitForRegex(ctx, opts.readyPattern, { timeoutMs });
  const elapsed = Date.now() - start;
  const remaining = Math.max(timeoutMs - elapsed, postReadyStabilityMs * 2);

  return waitForIdle(ctx, { stabilityMs: postReadyStabilityMs, timeoutMs: remaining });
}

// ─── waitForChange ───────────────────────────────────────────────────────────

/**
 * Round 4: resolve on the FIRST screen-changed event after this call returns.
 * Designed for "I just pressed an arrow key, wait for the TUI to redraw the
 * highlight, then check state." Returns the screen *after* the change.
 */
export function waitForChange(
  ctx: WaitContext,
  opts: WaitOptions = {},
): Promise<ScreenRead> {
  const timeoutMs = opts.timeoutMs ?? DEFAULTS.timeoutMs;
  return new Promise((resolve, reject) => {
    const onChanged = (): void => { cleanup(); resolve(ctx.snapshot()); };
    const onExit = (): void => { cleanup(); resolve(ctx.snapshot()); };
    const deadline = setTimeout(() => {
      cleanup();
      reject(new TestableTerminalError(
        ErrorCode.EXPECT_CHANGE_TIMEOUT,
        `screen never changed within ${timeoutMs}ms`,
        { snapshot: ctx.snapshot(), kind: "wait-change-timeout" },
      ));
    }, timeoutMs);
    const cleanup = (): void => {
      clearTimeout(deadline);
      ctx.emitter.off("screen-changed", onChanged);
      ctx.emitter.off("exit", onExit);
    };
    ctx.emitter.on("screen-changed", onChanged);
    ctx.emitter.on("exit", onExit);
  });
}

// ─── waitForExit ─────────────────────────────────────────────────────────────

/**
 * Round 4: resolve when the underlying process exits naturally. If already
 * exited at call time, resolves immediately (caller should pass current
 * exitCode/signal via a separate API on Session).
 */
export function waitForExit(
  ctx: WaitContext,
  opts: WaitOptions = {},
): Promise<void> {
  if (ctx.isExited()) return Promise.resolve();
  const timeoutMs = opts.timeoutMs ?? DEFAULTS.idleMaxMs;
  return new Promise((resolve, reject) => {
    const onExit = (): void => { cleanup(); resolve(); };
    const deadline = setTimeout(() => {
      cleanup();
      reject(new TestableTerminalError(
        ErrorCode.WAIT_EXIT_TIMEOUT,
        `process did not exit within ${timeoutMs}ms`,
        { snapshot: ctx.snapshot(), kind: "wait-exit-timeout" },
      ));
    }, timeoutMs);
    const cleanup = (): void => {
      clearTimeout(deadline);
      ctx.emitter.off("exit", onExit);
    };
    ctx.emitter.on("exit", onExit);
  });
}

// ─── helpers ────────────────────────────────────────────────────────────────

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
