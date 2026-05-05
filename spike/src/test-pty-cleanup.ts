/**
 * test-pty-cleanup — pin the orphan-cleanup behavior of Session.close() and
 * the global signal handlers, so killed spike harnesses don't leave 100% CPU
 * codex/ratatui-style children behind.
 *
 * Background:
 *   codex 0.128.0 (and similar ratatui-style TUIs) busy-loop on PTY EIO
 *   when the master end closes — they ignore SIGTERM and stay at 100% CPU.
 *   Until 2026-05-05 the spike's `Session.close()` only sent SIGTERM and
 *   the global cleanup didn't hook SIGHUP, so test runs that did
 *   `kill $SPIKE_PID` could leave stuck orphan processes.
 *
 *   This test fails if anyone removes the SIGKILL escalation in close()
 *   or the SIGHUP handler at the bottom of session.ts.
 *
 * Run:
 *   npm run spike:test-pty-cleanup
 */

import assert from "node:assert/strict";
import { startSession } from "./lib/session.js";

const log = (...a: unknown[]) => process.stderr.write(`[cleanup-test] ${a.map(String).join(" ")}\n`);

/**
 * Spawn a bash that traps SIGTERM/SIGHUP into no-ops and sleeps forever.
 * Only SIGKILL can stop it. close() must escalate within bounded time.
 */
async function caseSigkillEscalation(): Promise<void> {
  log("case=Session.close() SIGKILL escalation when SIGTERM is ignored");

  // Use python3 — bash's trap mechanics interact unpredictably with
  // node-pty's kill (signal may reach the inner `sleep` process before
  // bash reads it). Python's signal.SIG_IGN is unambiguous: SIGTERM and
  // SIGHUP are completely ignored at the kernel level until SIGKILL.
  // `os.kill(0, 0)` periodically self-checks the process is still alive
  // (no-op signal); the loop only exits via SIGKILL.
  const stubbornScript = `
import signal, time, os
signal.signal(signal.SIGTERM, signal.SIG_IGN)
signal.signal(signal.SIGHUP,  signal.SIG_IGN)
signal.signal(signal.SIGINT,  signal.SIG_IGN)
print('stubborn-ready', flush=True)
while True:
    time.sleep(0.1)
`;
  const session = await startSession({
    command: "python3",
    args: ["-c", stubbornScript],
    loginShell: false,
    rows: 24,
    cols: 80,
  });
  log(`  pid=${session.pid}, waiting for ready signal`);

  // Wait for python to install signal handlers — without this, racing the
  // close() against process startup can SIGTERM-kill it before SIG_IGN
  // is installed, giving a false pass.
  await session.waitForRegex(/stubborn-ready/, { timeoutMs: 5_000 });
  log(`  python is in ignore-loop, calling close()`);

  const start = Date.now();
  // gracefulTimeoutMs=500 → SIGTERM, wait 500ms (ignored), SIGKILL,
  // wait 500ms more for kernel reap. Total bounded under ~1100ms.
  const { exitCode } = await session.close({ gracefulTimeoutMs: 500 });
  const elapsed = Date.now() - start;
  log(`  elapsed=${elapsed}ms, exitCode=${exitCode}, exited=${session.stats().exited}`);

  // Lower bound: must wait at least gracefulTimeoutMs because SIGTERM is
  // ignored and SIGKILL only fires after the grace period. Without the
  // escalation, close() would hang forever (the existing setTimeout's
  // force-resolve doesn't actually kill the child).
  assert.ok(elapsed >= 500,
    `expected close to wait >= 500ms (SIGTERM grace) before SIGKILL, got ${elapsed}ms — ` +
    `SIGKILL escalation may be missing or grace timer wrong`);
  // Upper bound: SIGKILL is unblockable, kernel reaps quickly. 1500ms is
  // generous; longer means escalation didn't fire.
  assert.ok(elapsed < 1500,
    `expected close to complete within 1500ms total (500ms grace + SIGKILL + reap), got ${elapsed}ms — ` +
    `SIGKILL may not be reaching the child`);
  // Child must actually be reaped (exit event fired).
  assert.ok(session.stats().exited,
    `child must be reaped after SIGKILL; exited=${session.stats().exited}`);

  log("  ✓ pass");
}

/**
 * Verify SIGHUP triggers the cleanup path. We can't safely send SIGHUP to
 * ourselves (would terminate this test process), so instead assert that a
 * SIGHUP listener has been registered. The actual cleanup body is shared
 * with SIGINT/SIGTERM and pinned by caseSigkillEscalation.
 */
function caseSighupHandlerInstalled(): void {
  log("case=SIGHUP handler registered for orphan-cleanup");
  // session.ts installs SIGINT, SIGTERM, SIGHUP handlers as side effects of
  // module import. After importing startSession above, all three should be
  // present.
  const sighupCount = process.listenerCount("SIGHUP");
  assert.ok(sighupCount >= 1,
    `expected at least 1 SIGHUP listener after importing session module, got ${sighupCount}. ` +
    `If this fails, the SIGHUP path at the bottom of session.ts was removed — ` +
    `npm parents dying mid-test would orphan codex.`);
  log(`  ✓ SIGHUP listener count = ${sighupCount}`);

  // Sanity: SIGINT and SIGTERM must also stay registered.
  for (const sig of ["SIGINT", "SIGTERM"]) {
    const n = process.listenerCount(sig);
    assert.ok(n >= 1, `${sig} listener missing (count=${n})`);
  }
  log(`  ✓ SIGINT + SIGTERM listeners also present`);
}

async function main(): Promise<number> {
  let failures = 0;
  try {
    caseSighupHandlerInstalled();
  } catch (err) {
    log(`✗ FAIL [SIGHUP handler]: ${(err as Error).message}`);
    failures += 1;
  }
  try {
    await caseSigkillEscalation();
  } catch (err) {
    log(`✗ FAIL [SIGKILL escalation]: ${(err as Error).message}`);
    failures += 1;
  }

  if (failures > 0) {
    log(`\n${failures} test(s) failed`);
    return 1;
  }
  log("\nall tests passed");
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    log(`unexpected error: ${(err as Error).stack ?? err}`);
    process.exit(2);
  },
);
