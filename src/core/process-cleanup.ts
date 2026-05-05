/**
 * Process-level cleanup so orphan TUI processes don't outlive the host.
 *
 * Round 10 fix: previously the spike's liveSessions Set was declared but
 * never populated, making the SIGINT/SIGTERM/beforeExit hook a no-op. The
 * factory function `startSession()` MUST call `registerForCleanup(session)`,
 * and the session MUST emit `'exit'` so we can deregister.
 *
 * This module owns the global Set + the OS signal hooks. Tests can use
 * `__resetForTests()` to clear state between runs.
 */

import { logger } from "../utils/logger.js";

/** Minimal interface a session needs to expose to be cleanup-managed. */
export interface CleanupTarget {
  /** Best-effort kill (called from signal handler — must NOT throw). */
  kill(signal?: string): void;
  /** Subscribe to lifecycle so we can auto-deregister on natural exit. */
  once(event: "exit", listener: () => void): unknown;
  /** For diagnostics in cleanup logs. */
  readonly pid: number;
}

const liveSessions = new Set<CleanupTarget>();
let hooksInstalled = false;

/**
 * Add a session to the cleanup set. Auto-removes itself when the session
 * emits `'exit'`. Idempotent: re-registering the same session is a no-op.
 *
 * Call this from `startSession` AFTER the Session is constructed but
 * BEFORE returning to the caller.
 */
export function registerForCleanup(session: CleanupTarget): void {
  if (liveSessions.has(session)) return;
  liveSessions.add(session);
  session.once("exit", () => { liveSessions.delete(session); });
  ensureHooksInstalled();
}

/** Manually remove a session (rare — `'exit'` listener handles the common case). */
export function unregisterFromCleanup(session: CleanupTarget): void {
  liveSessions.delete(session);
}

/** Best-effort kill of every live session. Safe to call multiple times. */
export function killAllLiveSessions(signal: NodeJS.Signals = "SIGTERM"): number {
  let killed = 0;
  for (const s of liveSessions) {
    try {
      s.kill(signal);
      killed++;
    } catch (err) {
      logger.warn("cleanup.kill_failed", { pid: s.pid, error: (err as Error).message });
    }
  }
  return killed;
}

/** Number of currently-tracked sessions. Diagnostic only. */
export function liveSessionCount(): number {
  return liveSessions.size;
}

/** Reset state. **Tests only.** */
export function __resetForTests(): void {
  liveSessions.clear();
  // We don't try to remove process listeners — that'd fight other modules.
  // Setting hooksInstalled=false would re-add duplicates on next register;
  // safer to leave it true (handlers are idempotent).
}

function ensureHooksInstalled(): void {
  if (hooksInstalled) return;
  hooksInstalled = true;

  const cleanup = (signal: NodeJS.Signals): void => {
    const n = killAllLiveSessions(signal);
    if (n > 0) logger.info("cleanup.signal", { signal, killed: n });
  };

  process.on("SIGINT", () => { cleanup("SIGINT"); process.exit(130); });
  process.on("SIGTERM", () => { cleanup("SIGTERM"); process.exit(143); });
  process.on("beforeExit", () => cleanup("SIGTERM"));
  process.on("uncaughtException", (err) => {
    logger.error("cleanup.uncaught", { error: err.message, stack: err.stack });
    cleanup("SIGTERM");
    // Don't process.exit here — let Node's default uncaught handler do it.
  });
}
