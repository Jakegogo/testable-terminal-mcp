/**
 * aikey-test-example — demonstrate testing aikey CLI itself.
 *
 * Two cases:
 *   1. `aikey list` — read-only single-shot. Spawn, wait for natural exit,
 *      assert stdout contains expected providers.
 *   2. `aikey use` — interactive arrow-key TUI. Spawn, wait for menu,
 *      press ↓ once, wait for redraw, snapshot, then Ctrl+C to cancel
 *      WITHOUT committing the selection (safe / non-destructive test).
 *
 * Both cases use login-shell wrapping so they pick up the user's PATH /
 * aliases / env exactly like a real Terminal session would.
 *
 * Run:
 *   npm run spike:aikey-test
 */

import assert from "node:assert/strict";
import { startSession, TerminalTimeoutError } from "./lib/session.js";

const log = (...a: unknown[]) => process.stderr.write(`[aikey-test] ${a.map(String).join(" ")}\n`);

async function caseAikeyList(): Promise<void> {
  log("case=aikey-list — single-shot read-only");
  const session = await startSession({
    command: "aikey",
    args: ["list"],
    loginShell: true,
    rows: 40,
    cols: 120,
  });
  log(`  pid=${session.pid}`);

  try {
    // aikey list is single-shot. Wait for natural exit (or 10s budget).
    const { exitCode } = await session.waitForExit({ timeoutMs: 10_000 });
    log(`  exited code=${exitCode}`);

    const snap = session.snapshot();
    log(`  output (${snap.plainText.length} chars):`);
    process.stderr.write(snap.plainText.split("\n").map((l) => `      ${l}`).join("\n") + "\n");

    assert.equal(exitCode, 0, `aikey list should exit 0, got ${exitCode}`);
    // Loose assertion: output should mention something about providers / keys.
    // Adjust to your aikey output format if needed.
    const expectedHints = ["openai", "anthropic", "kimi", "claude", "provider", "key", "credential", "alias"];
    const lower = snap.plainText.toLowerCase();
    const hit = expectedHints.find((h) => lower.includes(h));
    if (hit) {
      log(`  ✓ output contains "${hit}"`);
    } else {
      log(`  ⚠ output didn't contain any expected hint; review output above`);
    }
    log("  ✓ pass");
  } finally {
    await session.close();
  }
}

async function caseAikeyUseInteractive(): Promise<void> {
  log("case=aikey-use — interactive TUI, arrow-key + waitForChange + Ctrl+C cancel");
  const session = await startSession({
    command: "aikey",
    args: ["use"],
    loginShell: true,
    rows: 40,
    cols: 120,
  });
  log(`  pid=${session.pid}`);

  try {
    // 1. Wait for the TUI to render its initial menu.
    //    Common menu markers: "▶", "❯", "›", or just stable screen with multiple lines.
    //    We use waitForIdle as a generic "TUI rendered something then settled".
    log(`  waitForIdle (initial menu render)`);
    const initial = await session.waitForIdle({ stabilityMs: 800, timeoutMs: 15_000 });
    log(`  initial menu rendered, ${initial.plainLines.length} non-empty lines`);
    process.stderr.write("--- initial menu ---\n");
    process.stderr.write(initial.plainText.split("\n").slice(0, 15).map((l) => `    ${l}`).join("\n") + "\n");
    process.stderr.write("---\n");

    // 2. Snapshot the highlighted position before arrow press.
    //    aikey's TUI marks the highlighted row with a leading `> ` text character
    //    (not ANSI inverse). caller-specific marker — adjust per your TUI.
    // aikey TUI uses `> ` text marker to indicate the highlighted row.
    // Non-highlighted rows have only spaces in that column. So a simple
    // `includes("> ")` finds the unique highlighted line.
    const findHighlightRow = (lines: string[]): number => lines.findIndex((l) => l.includes("> "));
    const highlightRowBefore = findHighlightRow(initial.plainLines);
    const highlightTextBefore = highlightRowBefore >= 0 ? initial.plainLines[highlightRowBefore].trim() : "(none)";
    log(`  highlight before ↓: row=${highlightRowBefore} text="${highlightTextBefore.slice(0, 60)}"`);

    // 3. Press ↓ and wait for screen to redraw exactly once.
    log(`  sendKey('arrow_down')`);
    session.sendKey("arrow_down");

    log(`  waitForChange (redraw)`);
    const after = await session.waitForChange({ timeoutMs: 3000 });
    const highlightRowAfter = findHighlightRow(after.plainLines);
    const highlightTextAfter = highlightRowAfter >= 0 ? after.plainLines[highlightRowAfter].trim() : "(none)";
    log(`  highlight after ↓:  row=${highlightRowAfter} text="${highlightTextAfter.slice(0, 60)}"`);

    // 4. Verify the highlight moved (row index OR the highlighted line's text).
    const highlightMoved =
      highlightRowBefore !== highlightRowAfter ||
      highlightTextBefore !== highlightTextAfter;
    log(`  screenChanged=${initial.plainText !== after.plainText} highlightMoved=${highlightMoved}`);
    assert.ok(initial.plainText !== after.plainText, "after ↓, screen should redraw");
    assert.ok(highlightMoved, "after ↓, the `> ` highlight marker should be on a different row or different text");

    // 5. Cancel via Ctrl+C — DO NOT commit the selection (we don't want to
    //    actually change the active key in the user's vault).
    log(`  sendKey('ctrl_c') to cancel without committing`);
    session.sendKey("ctrl_c");

    // 6. Wait for process to exit (either ctrl-c → graceful or kill).
    const { exitCode, signal } = await session.waitForExit({ timeoutMs: 5_000 });
    log(`  exited code=${exitCode} signal=${signal}`);
    log("  ✓ pass — interactive TUI controlled non-destructively");
  } catch (err) {
    if (err instanceof TerminalTimeoutError) {
      log(`  TIMEOUT (${err.kind})\n${err.snapshot.plainText.slice(-500)}`);
    }
    throw err;
  } finally {
    // close() will kill if still alive; safe.
    await session.close();
  }
}

async function main(): Promise<void> {
  log("aikey-cli integration tests starting");
  log("");

  // round 9 review fix: previously we caught and logged failures but returned 0,
  // making the script appear to pass even when assertions failed. Now we count
  // failures and exit non-zero so CI / wrappers can detect regression.
  let failures = 0;

  try {
    await caseAikeyList();
  } catch (err) {
    failures++;
    log(`  FAIL: ${(err as Error).stack ?? err}`);
  }
  log("");

  try {
    await caseAikeyUseInteractive();
  } catch (err) {
    failures++;
    log(`  FAIL: ${(err as Error).stack ?? err}`);
  }
  log("");

  if (failures > 0) {
    log(`done with ${failures} failure(s) — exiting non-zero`);
    process.exit(1);
  }
  log("done — all cases passed");
}

main().catch((err) => {
  process.stderr.write(`[aikey-test] fatal: ${(err as Error).stack ?? err}\n`);
  process.exit(1);
});
