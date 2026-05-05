/**
 * Windows mock-agent smoke (cron-only on CI; skipped locally on POSIX).
 *
 * Boots the in-process mock-llm-server, points ANTHROPIC_API_BASE at it,
 * spawns the real `claude` binary if available — but per spec the goal is
 * to verify the PTY/ConPTY/sandbox/snapshot link, NOT the binary itself.
 *
 * Local run on macOS: skips.
 * CI windows-mock-agent job: runs.
 *
 * If `claude` isn't on PATH (no install on the runner), the test still
 * exercises the mock server via a direct HTTP probe so failures isolate
 * to the binary side vs the link side.
 */

import { it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { startMockServer, type MockServerHandle } from "../fixtures/mock-llm-server.js";
import { startSession } from "../../src/core/terminal-session.js";
import { __resetForTests as resetCleanup } from "../../src/core/process-cleanup.js";
import { describeIfWindows } from "../integration-windows/_helpers.js";
import { execSync } from "node:child_process";

afterAll(() => { resetCleanup(); });

let mock: MockServerHandle;
const claudeOnPath = (() => {
  try { execSync("where claude", { stdio: "ignore" }); return true; }
  catch { return false; }
})();

describeIfWindows("Windows mock-agent — link verification", () => {
  beforeAll(async () => { mock = await startMockServer({ quiet: true }); });
  afterAll(async () => { if (mock) await mock.close(); });
  afterEach(() => { /* no per-test cleanup */ });

  it("mock server is reachable from the runner", async () => {
    const r = await fetch(`${mock.baseUrl}/healthz`);
    expect(r.status).toBe(200);
  });

  it("PTY → claude binary → mock LLM (skipped if claude unavailable)", async () => {
    if (!claudeOnPath) {
      // Skip with structured reason; the cron job decides whether absence
      // of claude is a deploy bug or expected.
      console.warn("[mock-agent-smoke] claude not on PATH — skipping link test");
      return;
    }
    const session = await startSession({
      command: "claude",
      args: ["--print", "5 + 10 = ?"],
      rows: 24,
      cols: 100,
      env: { ANTHROPIC_API_BASE: mock.baseUrl, ANTHROPIC_API_KEY: "mock-key-not-used" },
    });
    try {
      // Mock returns "15"; claude binary should print it.
      await session.waitForRegex(/\b15\b/, { timeoutMs: 30_000 });
    } finally {
      await session.close();
    }
  }, 35_000);
});
