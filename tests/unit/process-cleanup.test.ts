import { describe, it, expect, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import {
  registerForCleanup,
  unregisterFromCleanup,
  killAllLiveSessions,
  liveSessionCount,
  __resetForTests,
  type CleanupTarget,
} from "../../src/core/process-cleanup.js";

class FakeSession extends EventEmitter implements CleanupTarget {
  pid: number;
  killed = false;
  killSignal: string | undefined;
  constructor(pid: number) { super(); this.pid = pid; }
  override once(event: string | symbol, listener: (...args: unknown[]) => void): this {
    return super.once(event, listener);
  }
  kill(signal?: string): void {
    this.killed = true;
    this.killSignal = signal;
  }
}

beforeEach(() => { __resetForTests(); });

describe("registerForCleanup", () => {
  it("adds session to the live set", () => {
    expect(liveSessionCount()).toBe(0);
    const s = new FakeSession(1);
    registerForCleanup(s);
    expect(liveSessionCount()).toBe(1);
  });

  it("auto-removes on session 'exit'", () => {
    const s = new FakeSession(1);
    registerForCleanup(s);
    expect(liveSessionCount()).toBe(1);
    s.emit("exit");
    expect(liveSessionCount()).toBe(0);
  });

  it("idempotent: re-register same session is a no-op", () => {
    const s = new FakeSession(1);
    registerForCleanup(s);
    registerForCleanup(s);
    expect(liveSessionCount()).toBe(1);
  });

  it("handles multiple sessions independently", () => {
    const a = new FakeSession(1);
    const b = new FakeSession(2);
    registerForCleanup(a);
    registerForCleanup(b);
    expect(liveSessionCount()).toBe(2);
    a.emit("exit");
    expect(liveSessionCount()).toBe(1);
    b.emit("exit");
    expect(liveSessionCount()).toBe(0);
  });
});

describe("unregisterFromCleanup", () => {
  it("removes a session manually", () => {
    const s = new FakeSession(1);
    registerForCleanup(s);
    unregisterFromCleanup(s);
    expect(liveSessionCount()).toBe(0);
  });

  it("is a no-op for unknown session", () => {
    const s = new FakeSession(1);
    unregisterFromCleanup(s);  // never registered
    expect(liveSessionCount()).toBe(0);
  });
});

describe("killAllLiveSessions", () => {
  it("calls kill() on every tracked session", () => {
    const a = new FakeSession(1);
    const b = new FakeSession(2);
    registerForCleanup(a);
    registerForCleanup(b);
    const n = killAllLiveSessions("SIGTERM");
    expect(n).toBe(2);
    expect(a.killed).toBe(true);
    expect(b.killed).toBe(true);
    expect(a.killSignal).toBe("SIGTERM");
  });

  it("does not throw if a session.kill() throws", () => {
    const s = new FakeSession(1);
    s.kill = (): never => { throw new Error("boom"); };
    registerForCleanup(s);
    expect(() => killAllLiveSessions()).not.toThrow();
  });

  it("returns 0 when set is empty", () => {
    expect(killAllLiveSessions()).toBe(0);
  });
});
