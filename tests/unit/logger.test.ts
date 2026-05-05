import { describe, it, expect, vi } from "vitest";
import { Writable } from "node:stream";
import { createLogger, type LogLevel } from "../../src/utils/logger.js";

function captureStream(): { stream: Writable; lines: () => string[] } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) { chunks.push(chunk.toString()); cb(); },
  });
  return { stream, lines: () => chunks.join("").split("\n").filter(Boolean) };
}

describe("logger JSON mode (default)", () => {
  it("emits one JSON line per call with ts/level/msg", () => {
    const { stream, lines } = captureStream();
    const log = createLogger({ out: stream, now: () => new Date("2026-05-05T00:00:00Z") });
    log.info("hello", { req_id: "abc" });
    log.warn("watch out");
    const out = lines();
    expect(out).toHaveLength(2);
    const a = JSON.parse(out[0]!);
    expect(a).toEqual({ ts: "2026-05-05T00:00:00.000Z", level: "info", msg: "hello", req_id: "abc" });
    const b = JSON.parse(out[1]!);
    expect(b.level).toBe("warn");
    expect(b.msg).toBe("watch out");
  });

  it("respects level filter (info default suppresses debug)", () => {
    const { stream, lines } = captureStream();
    const log = createLogger({ out: stream });
    log.debug("ignored");
    log.info("kept");
    expect(lines()).toHaveLength(1);
    expect(JSON.parse(lines()[0]!).msg).toBe("kept");
  });

  it("setLevel changes filter on the fly", () => {
    const { stream, lines } = captureStream();
    const log = createLogger({ out: stream });
    log.debug("dropped");
    log.setLevel("debug" as LogLevel);
    log.debug("kept");
    expect(lines()).toHaveLength(1);
  });

  it("child logger inherits base + adds extras", () => {
    const { stream, lines } = captureStream();
    const parent = createLogger({ out: stream, base: { service: "ttm" } });
    const child = parent.child({ session_id: "s1" });
    child.info("event");
    const e = JSON.parse(lines()[0]!);
    expect(e.service).toBe("ttm");
    expect(e.session_id).toBe("s1");
  });
});

describe("logger pretty mode", () => {
  it("renders human-readable single line", () => {
    const { stream, lines } = captureStream();
    const log = createLogger({ out: stream, pretty: true, now: () => new Date("2026-05-05T00:00:00Z") });
    log.info("hello", { x: 1, y: "z" });
    expect(lines()[0]).toContain("INFO hello");
    expect(lines()[0]).toContain("x=1");
    expect(lines()[0]).toContain("y=z");
  });
});
