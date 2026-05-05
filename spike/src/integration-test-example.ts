/**
 * integration-test-example — demonstrate importing lib/session directly
 * from an integration test (vitest / jest / plain async script).
 *
 * Two ways to use it:
 *
 *   1. High-level (most common): one-shot helper.
 *        const { reply } = await askClaude({ prompt: "..." });
 *
 *   2. Low-level: own the Session, drive it manually.
 *        const session = await startSession({ command: "claude", loginShell: true });
 *        await session.waitForReady();
 *        session.write("..."); session.sendKey("enter");
 *        await session.waitForRegex(/⏺/);
 *        await session.waitForIdle({ stabilityMs: 1500 });
 *        const reply = session.snapshot().plainText;
 *        await session.close();
 *
 * This file runs both modes as a sanity check. Convert to .test.ts and
 * call `expect()` instead of `assert()` for vitest / jest.
 *
 * Run:
 *   npm run spike:integration-test
 */

import assert from "node:assert/strict";
import { askClaude, startSession, extractClaudeReply, TerminalTimeoutError } from "./lib/session.js";

const log = (...a: unknown[]) => process.stderr.write(`[itest] ${a.map(String).join(" ")}\n`);

async function caseHighLevel(): Promise<void> {
  log("case=high-level — askClaude one-shot");
  const t0 = Date.now();
  const res = await askClaude({
    prompt: "compute seven plus eight, reply with only the resulting number, no words",
    timeoutMs: 120_000,
    loginShell: true,
    verbose: false,
  });
  log(`  elapsed=${Date.now() - t0}ms ok=${res.ok}`);
  log(`  reply=${JSON.stringify(res.reply)}`);

  assert.equal(res.ok, true, `askClaude should succeed, reason: ${res.reason}`);
  assert.match(res.reply, /15/, "reply must contain 15");
  log("  ✓ pass");
}

async function caseLowLevel(): Promise<void> {
  log("case=low-level — manual Session control");
  const session = await startSession({
    command: "claude",
    loginShell: true,
    rows: 40,
    cols: 120,
  });
  log(`  pid=${session.pid}`);

  // Optional: subscribe to data events for streaming use.
  let dataChunks = 0;
  session.on("data", () => { dataChunks++; });

  try {
    log("  waitForReady");
    await session.waitForReady({ readyPattern: /❯\s/, timeoutMs: 30_000 });

    log("  write+enter");
    session.write("respond with the single english word for the answer to 2+2 (no punctuation)");
    await new Promise((r) => setTimeout(r, 150));
    session.sendKey("enter");

    log("  waitForRegex(⏺)");
    await session.waitForRegex(/⏺/, { timeoutMs: 90_000 });

    log("  waitForIdle(1500ms) — race with ✻ Crunched marker");
    const idleP = session.waitForIdle({ stabilityMs: 1500, timeoutMs: 90_000 });
    const crunchedP = session.waitForRegex(/✻\s+Crunched for/, { timeoutMs: 90_000 })
      .then(() => session.snapshot())
      .catch(() => undefined);
    const finalSnap = await Promise.race([idleP, crunchedP.then((s) => s ?? session.snapshot())]);
    void finalSnap;

    const reply = extractClaudeReply(session.snapshot());
    log(`  data chunks observed via event=${dataChunks}`);
    log(`  reply=${JSON.stringify(reply?.plain)}`);

    assert.ok(reply, "reply should extract");
    assert.match(reply!.plain.toLowerCase(), /four/, "reply should contain 'four'");
    log("  ✓ pass");
  } catch (err) {
    if (err instanceof TerminalTimeoutError) {
      log(`  TIMEOUT (${err.kind}) — partial screen:\n${err.snapshot.plainText.slice(-500)}`);
    }
    throw err;
  } finally {
    await session.close();
  }
}

async function caseStreamingSubscribe(): Promise<void> {
  log("case=streaming — subscribe to live data events while Claude streams");
  const session = await startSession({ command: "claude", loginShell: true });
  let bytesSeenWhileGenerating = 0;
  let firstReplyChunkAt: number | null = null;

  session.on("data", (data: string) => {
    // The simplest streaming heuristic: count bytes after we've seen ⏺ on screen.
    if (session.snapshot().plainText.includes("⏺ ")) {
      if (firstReplyChunkAt === null) firstReplyChunkAt = Date.now();
      bytesSeenWhileGenerating += Buffer.byteLength(data, "utf8");
    }
  });

  const t0 = Date.now();
  try {
    await session.waitForReady({ readyPattern: /❯\s/, timeoutMs: 30_000 });
    session.write("count from 1 to 5, one number per line, no other text");
    await new Promise((r) => setTimeout(r, 150));
    session.sendKey("enter");
    await session.waitForRegex(/⏺/, { timeoutMs: 60_000 });
    await session.waitForIdle({ stabilityMs: 1500, timeoutMs: 60_000 });

    const reply = extractClaudeReply(session.snapshot());
    log(`  reply=${JSON.stringify(reply?.plain)}`);
    log(`  streaming bytes observed=${bytesSeenWhileGenerating}, first chunk at +${firstReplyChunkAt ? firstReplyChunkAt - t0 : "n/a"}ms`);

    assert.ok(reply, "reply should extract");
    assert.ok(bytesSeenWhileGenerating > 0, "should have observed at least some bytes during generation via 'data' event");
    log("  ✓ pass");
  } finally {
    await session.close();
  }
}

async function main(): Promise<void> {
  log("integration tests starting (auto mode = real Claude, costs tokens)");
  log("");

  await caseHighLevel();
  log("");

  await caseLowLevel();
  log("");

  await caseStreamingSubscribe();
  log("");

  log("all cases passed ✓");
}

main().catch((err) => {
  process.stderr.write(`[itest] FAIL: ${(err as Error).stack ?? err}\n`);
  process.exit(1);
});
