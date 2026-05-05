/**
 * history-example — demo session history APIs.
 *
 * Shows that even in headless mode (no log file), every byte of the PTY
 * stream is accumulated in memory and retrievable via getRawHistory /
 * getCleanHistory / getHistoryStats. With historyLogPath set, bytes are
 * also mirrored to disk.
 *
 * Run: tsx src/history-example.ts
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { startSession } from "./lib/session.js";

const log = (...a: unknown[]) => process.stderr.write(`[hist] ${a.map(String).join(" ")}\n`);

async function caseHeadlessHistoryInMemory(): Promise<void> {
  log("case=headless: history accumulated in memory only");
  const session = await startSession({
    command: "bash",
    rows: 24,
    cols: 80,
    // display defaults to "headless", historyLogPath is unset → no disk file
  });
  // Run a tiny scripted sequence.
  session.write("echo HISTORY_DEMO_LINE_1\n");
  await session.waitForRegex(/HISTORY_DEMO_LINE_1/, { timeoutMs: 3000 });
  session.write("printf '\\033[31mRED\\033[0m PLAIN\\n'\n");
  await session.waitForRegex(/PLAIN/, { timeoutMs: 3000 });
  session.write("exit\n");
  await session.waitForExit({ timeoutMs: 3000 });

  const stats = session.getHistoryStats();
  const raw = session.getRawHistory();
  const clean = session.getCleanHistory();
  log(`  bytes=${stats.bytes} chunks=${stats.chunks} truncated=${stats.truncated} path=${stats.path ?? "(in-memory only)"}`);
  log(`  raw includes ANSI? ${raw.includes("\x1b[31m") ? "yes" : "no"}`);
  log(`  clean text excerpt: ${JSON.stringify(clean.split("\n").filter((l) => l.includes("DEMO") || l.includes("RED")).join(" | "))}`);

  assert.equal(stats.path, null, "headless mode should not write to disk");
  assert.ok(raw.includes("HISTORY_DEMO_LINE_1"), "raw history should contain echo output");
  assert.ok(raw.includes("\x1b[31m"), "raw history should preserve ANSI escapes");
  assert.ok(clean.includes("RED PLAIN"), "clean history should have ANSI stripped");
  assert.ok(!clean.includes("\x1b["), "clean history should have no ESC sequences");
  log("  ✓ pass\n");

  await session.close();
}

async function caseHistoryLogPath(): Promise<void> {
  log("case=historyLogPath: bytes also mirrored to disk");
  const logPath = path.join(os.tmpdir(), `ttm-history-demo-${Date.now()}.log`);
  const session = await startSession({
    command: "bash",
    rows: 24,
    cols: 80,
    historyLogPath: logPath,
  });
  session.write("echo DISK_MIRROR_TEST\n");
  await session.waitForRegex(/DISK_MIRROR_TEST/, { timeoutMs: 3000 });
  session.write("exit\n");
  await session.waitForExit({ timeoutMs: 3000 });
  // Give writeStream time to flush after onExit.
  await new Promise((r) => setTimeout(r, 200));

  const stats = session.getHistoryStats();
  const onDisk = fs.readFileSync(logPath, "utf8");
  log(`  in-memory bytes=${stats.bytes} on-disk bytes=${onDisk.length} path=${stats.path}`);
  log(`  on-disk excerpt: ${JSON.stringify(onDisk.split("\n").find((l) => l.includes("DISK_MIRROR_TEST")) ?? "(not found)")}`);

  assert.equal(stats.path, logPath);
  assert.ok(onDisk.includes("DISK_MIRROR_TEST"), "disk file should contain echo output");
  assert.ok(Math.abs(onDisk.length - stats.bytes) < 10, "in-memory and on-disk byte counts should match (within trim)");
  log("  ✓ pass\n");

  fs.unlinkSync(logPath);
  await session.close();
}

async function caseRingBufferTruncation(): Promise<void> {
  log("case=ring-buffer truncation: tiny maxHistoryBytes triggers FIFO drop");
  const session = await startSession({
    command: "bash",
    rows: 24,
    cols: 80,
    maxHistoryBytes: 256,    // intentionally small
  });
  // Pump a lot more than 256 bytes.
  session.write("for i in $(seq 1 50); do echo \"HISTORY_LINE_$i\"; done\n");
  await session.waitForRegex(/HISTORY_LINE_50/, { timeoutMs: 5000 });
  session.write("exit\n");
  await session.waitForExit({ timeoutMs: 3000 });

  const stats = session.getHistoryStats();
  const raw = session.getRawHistory();
  log(`  bytes=${stats.bytes} truncated=${stats.truncated} chunks=${stats.chunks}`);
  log(`  early lines preserved? HISTORY_LINE_1: ${raw.includes("HISTORY_LINE_1\r") ? "yes" : "no (dropped, expected)"}`);
  log(`  late lines preserved?  HISTORY_LINE_50: ${raw.includes("HISTORY_LINE_50") ? "yes" : "no"}`);

  assert.ok(stats.truncated, "with maxHistoryBytes=256, ring should have truncated");
  assert.ok(stats.bytes <= 256 * 2, `bytes=${stats.bytes} should be roughly bounded by maxHistoryBytes (allowing one-chunk overflow)`);
  assert.ok(raw.includes("HISTORY_LINE_50"), "newest output should always be retained");
  log("  ✓ pass\n");

  await session.close();
}

async function main(): Promise<void> {
  log("history API demo starting\n");
  await caseHeadlessHistoryInMemory();
  await caseHistoryLogPath();
  await caseRingBufferTruncation();
  log("all cases passed ✓");
}

main().catch((err) => {
  process.stderr.write(`[hist] fatal: ${(err as Error).stack ?? err}\n`);
  process.exit(1);
});
