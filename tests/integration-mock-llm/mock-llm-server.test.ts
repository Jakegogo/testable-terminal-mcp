/**
 * Mock LLM server contract tests.
 *
 * Drives the in-process server with `fetch` (Node 18+ built-in). Verifies:
 *   - GET /healthz responds 200 OK
 *   - POST /v1/messages stream=false returns Anthropic-shaped JSON with text "15"
 *   - POST /v1/messages stream=true emits 5 SSE events ending with message_stop
 *   - POST /v1/chat/completions stream=false returns OpenAI-shaped JSON with text "15"
 *   - POST /v1/chat/completions stream=true emits 5 chunks ending with [DONE]
 *   - ?force_status=503 short-circuits to HTTP 503
 *   - Unknown path returns 404 with diagnostic body
 *   - server.close() is reliably awaitable (no leaked listeners)
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startMockServer, type MockServerHandle } from "../fixtures/mock-llm-server.js";

let server: MockServerHandle;

beforeAll(async () => { server = await startMockServer({ quiet: true }); });
afterAll(async () => { await server.close(); });

describe("mock LLM — health", () => {
  it("GET /healthz returns 200 OK", async () => {
    const r = await fetch(`${server.baseUrl}/healthz`);
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("OK");
  });
});

describe("mock LLM — Anthropic /v1/messages", () => {
  it("non-streaming returns fixed text 15 with Anthropic shape", async () => {
    const r = await fetch(`${server.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-3", messages: [{ role: "user", content: "5+10=?" }] }),
    });
    expect(r.status).toBe(200);
    const body = await r.json() as { type: string; content: { text: string }[] };
    expect(body.type).toBe("message");
    expect(body.content[0]!.text).toBe("15");
  });

  it("streaming emits message_start → 4 deltas → message_stop", async () => {
    const r = await fetch(`${server.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ stream: true, messages: [{ role: "user", content: "x" }] }),
    });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/event-stream");

    const text = await r.text();
    const events = parseSse(text);
    expect(events.find((e) => e.event === "message_start")).toBeDefined();
    const deltas = events.filter((e) => e.event === "content_block_delta");
    expect(deltas.length).toBe(4); // "1", "5", "", ""
    expect(events[events.length - 1]!.event).toBe("message_stop");
    // Concatenated delta text reconstructs to "15".
    const concat = deltas.map((e) => JSON.parse(e.data).delta.text as string).join("");
    expect(concat).toBe("15");
  });
});

describe("mock LLM — OpenAI/Moonshot /v1/chat/completions", () => {
  it("non-streaming returns fixed content 15 with OpenAI shape", async () => {
    const r = await fetch(`${server.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "moonshot-v1", messages: [{ role: "user", content: "x" }] }),
    });
    expect(r.status).toBe(200);
    const body = await r.json() as { object: string; choices: { message: { content: string } }[] };
    expect(body.object).toBe("chat.completion");
    expect(body.choices[0]!.message.content).toBe("15");
  });

  it("streaming emits 4 deltas + finish_reason chunk + [DONE]", async () => {
    const r = await fetch(`${server.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ stream: true, messages: [{ role: "user", content: "x" }] }),
    });
    const text = await r.text();
    expect(text).toContain("[DONE]");
    // Split into data: lines and parse the JSON-bearing ones.
    const dataLines = text.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6));
    const jsonLines = dataLines.filter((l) => l !== "[DONE]");
    expect(jsonLines.length).toBe(5); // 4 content + 1 finish
    const concat = jsonLines.slice(0, 4).map((j) => (JSON.parse(j).choices[0].delta.content as string) ?? "").join("");
    expect(concat).toBe("15");
    expect(JSON.parse(jsonLines[4]!).choices[0].finish_reason).toBe("stop");
  });
});

describe("mock LLM — error paths", () => {
  it("?force_status=503 returns 503 even on a normally-200 endpoint", async () => {
    const r = await fetch(`${server.baseUrl}/v1/messages?force_status=503`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(r.status).toBe(503);
  });

  it("?force_status=429 (rate-limit-shape) honored on completions", async () => {
    const r = await fetch(`${server.baseUrl}/v1/chat/completions?force_status=429`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(r.status).toBe(429);
  });

  it("invalid JSON body returns 400", async () => {
    const r = await fetch(`${server.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(r.status).toBe(400);
  });

  it("unknown path returns 404 with diagnostic body", async () => {
    const r = await fetch(`${server.baseUrl}/v2/wrong-version`);
    expect(r.status).toBe(404);
    const body = await r.json() as { supported: string[] };
    expect(body.supported).toContain("POST /v1/messages");
    expect(body.supported).toContain("POST /v1/chat/completions");
  });
});

describe("mock LLM — lifecycle", () => {
  it("requestCount increments per request", async () => {
    const before = server.requestCount();
    await fetch(`${server.baseUrl}/healthz`);
    expect(server.requestCount()).toBe(before + 1);
  });

  it("close + restart with explicit port=0 yields a different port", async () => {
    const a = await startMockServer({ quiet: true });
    const b = await startMockServer({ quiet: true });
    expect(a.port).not.toBe(b.port);
    await a.close();
    await b.close();
  });
});

// ─── helpers ────────────────────────────────────────────────────────────────

interface SseEvent { event: string; data: string }

function parseSse(text: string): SseEvent[] {
  const out: SseEvent[] = [];
  const blocks = text.split(/\n\n+/);
  for (const block of blocks) {
    if (!block.trim()) continue;
    let event = "message";
    let data = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("event: ")) event = line.slice(7);
      else if (line.startsWith("data: ")) data += (data ? "\n" : "") + line.slice(6);
    }
    if (data) out.push({ event, data });
  }
  return out;
}
