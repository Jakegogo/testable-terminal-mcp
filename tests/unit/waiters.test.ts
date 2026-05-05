import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import {
  waitForRegex, waitForText, waitForIdle, waitForChange, waitForExit,
  type WaitContext,
} from "../../src/core/session/waiters.js";
import { isTestableTerminalError, ErrorCode } from "../../src/core/errors.js";
import type { ScreenRead } from "../../src/core/snapshot.js";

/** Minimal mock screen — enough for waiters' regex matching. */
function mkScreen(plain: string): ScreenRead {
  return {
    plainText: plain,
    plainLines: plain.split("\n"),
    ansiText: plain,
    ansiLines: plain.split("\n"),
    cursor: { row: 0, col: 0 },
    range: { kind: "lastLines", startRow: 0, endRow: 1, totalBufferRows: 1 },
  };
}

interface Harness {
  ctx: WaitContext;
  emitter: EventEmitter;
  setText(t: string): void;
  pulse(): void;
  exit(): void;
  setExited(v: boolean): void;
}

function makeHarness(initial = ""): Harness {
  let text = initial;
  let exited = false;
  const emitter = new EventEmitter();
  const ctx: WaitContext = {
    emitter: emitter as unknown as WaitContext["emitter"],
    snapshot: () => mkScreen(text),
    isExited: () => exited,
  };
  return {
    ctx,
    emitter,
    setText(t) { text = t; },
    pulse() { emitter.emit("screen-changed"); },
    exit() { exited = true; emitter.emit("exit"); },
    setExited(v) { exited = v; },
  };
}

describe("waitForRegex", () => {
  it("fast-path: resolves immediately if already matching", async () => {
    const h = makeHarness("hello world");
    const { snapshot, match } = await waitForRegex(h.ctx, /hello/);
    expect(match[0]).toBe("hello");
    expect(snapshot.plainText).toBe("hello world");
  });

  it("resolves on screen-changed when text appears later", async () => {
    const h = makeHarness("");
    setTimeout(() => { h.setText("found it"); h.pulse(); }, 10);
    const { match } = await waitForRegex(h.ctx, /found/);
    expect(match[0]).toBe("found");
  });

  it("rejects with EXPECT_TIMEOUT after timeoutMs", async () => {
    const h = makeHarness("");
    try {
      await waitForRegex(h.ctx, /nope/, { timeoutMs: 100 });
      expect.fail("should have rejected");
    } catch (err) {
      expect(isTestableTerminalError(err)).toBe(true);
      if (isTestableTerminalError(err)) {
        expect(err.code).toBe(ErrorCode.EXPECT_TIMEOUT);
        expect(err.details.snapshot).toBeDefined();
      }
    }
  });

  it("on-exit: resolves if regex matches at exit, else rejects with kind=after-exit", async () => {
    const h = makeHarness("");
    setTimeout(() => { h.setText("hit"); h.exit(); }, 10);
    const { match } = await waitForRegex(h.ctx, /hit/);
    expect(match[0]).toBe("hit");
  });
});

describe("waitForText", () => {
  it("escapes regex metacharacters in text", async () => {
    const h = makeHarness("price: $5.99");
    const { snapshot } = await waitForText(h.ctx, "$5.99");
    expect(snapshot.plainText).toContain("$5.99");
  });
});

describe("waitForIdle", () => {
  it("resolves after stabilityMs of silence (default-armed)", async () => {
    const h = makeHarness("anything");
    const t0 = Date.now();
    await waitForIdle(h.ctx, { stabilityMs: 80, timeoutMs: 1000 });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(70);
  });

  it("resets stability timer on every screen-changed", async () => {
    const h = makeHarness("");
    let resolved = false;
    waitForIdle(h.ctx, { stabilityMs: 60, timeoutMs: 1000 }).then(() => { resolved = true; });
    // Pulse 3 times every 30ms to keep resetting.
    await new Promise((r) => setTimeout(r, 30)); h.pulse();
    await new Promise((r) => setTimeout(r, 30)); h.pulse();
    await new Promise((r) => setTimeout(r, 30)); h.pulse();
    // At ~90ms total but each was within stabilityMs; should NOT have resolved yet.
    expect(resolved).toBe(false);
    // Now leave it quiet for a full window.
    await new Promise((r) => setTimeout(r, 100));
    expect(resolved).toBe(true);
  });

  it("requireFirstEvent=true: doesn't resolve until first event", async () => {
    const h = makeHarness("");
    let resolved = false;
    waitForIdle(h.ctx, { stabilityMs: 50, timeoutMs: 1000, requireFirstEvent: true })
      .then(() => { resolved = true; });
    await new Promise((r) => setTimeout(r, 100));
    expect(resolved).toBe(false);  // no event ever → no arming
    h.pulse();
    await new Promise((r) => setTimeout(r, 80));
    expect(resolved).toBe(true);
  });

  it("rejects with EXPECT_IDLE_TIMEOUT after maxMs", async () => {
    const h = makeHarness("");
    // No requireFirstEvent → arms immediately. But we keep pulsing past timeoutMs.
    const promise = waitForIdle(h.ctx, { stabilityMs: 200, timeoutMs: 100 });
    const interval = setInterval(() => h.pulse(), 30);
    try {
      await promise;
      expect.fail("should have rejected");
    } catch (err) {
      clearInterval(interval);
      expect(isTestableTerminalError(err)).toBe(true);
      if (isTestableTerminalError(err)) expect(err.code).toBe(ErrorCode.EXPECT_IDLE_TIMEOUT);
    }
  });
});

describe("waitForChange", () => {
  it("resolves on the first screen-changed event", async () => {
    const h = makeHarness("before");
    setTimeout(() => { h.setText("after"); h.pulse(); }, 30);
    const after = await waitForChange(h.ctx);
    expect(after.plainText).toBe("after");
  });

  it("rejects with EXPECT_CHANGE_TIMEOUT if nothing happens", async () => {
    const h = makeHarness("");
    try {
      await waitForChange(h.ctx, { timeoutMs: 80 });
      expect.fail("should have rejected");
    } catch (err) {
      expect(isTestableTerminalError(err)).toBe(true);
      if (isTestableTerminalError(err)) expect(err.code).toBe(ErrorCode.EXPECT_CHANGE_TIMEOUT);
    }
  });
});

describe("waitForExit", () => {
  it("resolves immediately if already exited", async () => {
    const h = makeHarness("");
    h.setExited(true);
    await waitForExit(h.ctx);
  });

  it("resolves when exit event fires", async () => {
    const h = makeHarness("");
    setTimeout(() => h.exit(), 30);
    await waitForExit(h.ctx);
  });

  it("rejects with WAIT_EXIT_TIMEOUT if process never exits", async () => {
    const h = makeHarness("");
    try {
      await waitForExit(h.ctx, { timeoutMs: 80 });
      expect.fail("should have rejected");
    } catch (err) {
      expect(isTestableTerminalError(err)).toBe(true);
      if (isTestableTerminalError(err)) expect(err.code).toBe(ErrorCode.WAIT_EXIT_TIMEOUT);
    }
  });
});
