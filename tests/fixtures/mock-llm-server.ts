/**
 * Mock LLM HTTP server — fixture for Windows nightly mock-agent jobs.
 *
 * Purpose (per spec §9.2): verify the PTY → claude/kimi client → API link
 * works on Windows, WITHOUT calling the real model layer. The model output
 * is fixed to "15" so the spike-style arithmetic prompt ("5 + 10 = ?") can
 * pattern-match the response.
 *
 * Endpoints:
 *   POST /v1/messages              — Anthropic shape
 *   POST /v1/chat/completions      — OpenAI / Moonshot shape
 *   GET  /healthz                  — 200 OK
 *
 *   Anything else → 404 with body listing the supported paths.
 *
 * Behavior:
 *   stream=false → one-shot JSON response
 *   stream=true  → SSE stream of 5 events ("1", "5", "", "", done)
 *   ?force_status=N (any path) → respond with HTTP N (no body) for retry / error tests
 *
 * Lifecycle:
 *   - server.listen(0) → OS-assigned port
 *   - On startup: writes `MOCK_LLM_PORT=NNNN` to stdout (one line, machine-readable)
 *   - Logs requests to stderr (logger; never stdout)
 *   - Single-process, no persistence
 *
 * Standalone run:
 *   tsx tests/fixtures/mock-llm-server.ts          # foreground
 *   tsx tests/fixtures/mock-llm-server.ts --quiet  # don't log requests
 */

import * as http from "node:http";
import { logger } from "../../src/utils/logger.js";

// ─── public types ────────────────────────────────────────────────────────────

export interface MockServerHandle {
  port: number;
  baseUrl: string;
  /** Total requests received (test diagnostic). */
  requestCount(): number;
  close(): Promise<void>;
}

export interface StartOpts {
  /** Bind address. Default 127.0.0.1 (loopback only). */
  host?: string;
  /** Override port. Default 0 (OS-assigned). */
  port?: number;
  /** When true, suppress per-request logging. */
  quiet?: boolean;
}

const FIXED_REPLY = "15";
/** Stream events per spec: "1", "5", "", "", done. */
const STREAM_TOKENS = ["1", "5", "", ""];

// ─── public API ──────────────────────────────────────────────────────────────

export async function startMockServer(opts: StartOpts = {}): Promise<MockServerHandle> {
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 0;
  let count = 0;
  const log = opts.quiet ? () => { /* noop */ } : (event: string, data: object) => logger.info(event, data);

  const server = http.createServer((req, res) => {
    count++;
    handle(req, res, log).catch((err) => {
      log("mock_llm.handler_error", { error: (err as Error).message });
      try {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: "internal_error", message: (err as Error).message }));
      } catch { /* connection already closed */ }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });

  const addr = server.address();
  if (typeof addr !== "object" || addr === null) {
    throw new Error("server.address() returned unexpected value");
  }
  const actualPort = addr.port;
  log("mock_llm.listening", { host, port: actualPort });

  return {
    port: actualPort,
    baseUrl: `http://${host}:${actualPort}`,
    requestCount: () => count,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// ─── request handling ───────────────────────────────────────────────────────

async function handle(req: http.IncomingMessage, res: http.ServerResponse, log: (event: string, data: object) => void): Promise<void> {
  const url = new URL(req.url ?? "/", "http://placeholder");
  const path = url.pathname;
  const force = url.searchParams.get("force_status");
  log("mock_llm.request", { method: req.method, path });

  // ?force_status=N short-circuit (used by retry / error-path tests).
  if (force) {
    const n = parseInt(force, 10);
    if (Number.isFinite(n) && n >= 100 && n < 600) {
      res.statusCode = n;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "force_status", status: n }));
      return;
    }
  }

  // Health probe.
  if (req.method === "GET" && path === "/healthz") {
    res.statusCode = 200;
    res.setHeader("content-type", "text/plain");
    res.end("OK");
    return;
  }

  // POST endpoints.
  if (req.method === "POST" && (path === "/v1/messages" || path === "/v1/chat/completions")) {
    const body = await readBody(req);
    let parsed: { stream?: boolean; messages?: unknown };
    try {
      parsed = JSON.parse(body || "{}");
    } catch (err) {
      res.statusCode = 400;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "invalid_json", message: (err as Error).message }));
      return;
    }
    const stream = parsed.stream === true;
    if (stream) {
      await writeSseResponse(res, path);
    } else {
      writeJsonResponse(res, path);
    }
    return;
  }

  // Unknown path: 404 with diagnostic body.
  res.statusCode = 404;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({
    error: "not_found",
    method: req.method,
    path,
    supported: ["GET /healthz", "POST /v1/messages", "POST /v1/chat/completions"],
  }));
}

function writeJsonResponse(res: http.ServerResponse, path: string): void {
  res.statusCode = 200;
  res.setHeader("content-type", "application/json");
  if (path === "/v1/messages") {
    // Anthropic Messages API non-streaming response shape.
    res.end(JSON.stringify({
      id: "msg_mock_001",
      type: "message",
      role: "assistant",
      model: "mock-claude-3",
      content: [{ type: "text", text: FIXED_REPLY }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    }));
  } else {
    // OpenAI / Moonshot Chat Completions non-streaming shape.
    res.end(JSON.stringify({
      id: "chatcmpl-mock-001",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: "moonshot-v1-mock",
      choices: [{
        index: 0,
        message: { role: "assistant", content: FIXED_REPLY },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }));
  }
}

async function writeSseResponse(res: http.ServerResponse, path: string): Promise<void> {
  res.statusCode = 200;
  res.setHeader("content-type", "text/event-stream");
  res.setHeader("cache-control", "no-cache");
  res.setHeader("connection", "keep-alive");

  if (path === "/v1/messages") {
    // Anthropic SSE event names per documented protocol (subset).
    write(res, "event: message_start\n");
    write(res, "data: " + JSON.stringify({
      type: "message_start",
      message: { id: "msg_mock_001", role: "assistant", content: [], model: "mock-claude-3", usage: { input_tokens: 1, output_tokens: 0 } },
    }) + "\n\n");
    for (const tok of STREAM_TOKENS) {
      write(res, "event: content_block_delta\n");
      write(res, "data: " + JSON.stringify({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: tok },
      }) + "\n\n");
    }
    write(res, "event: message_stop\n");
    write(res, "data: " + JSON.stringify({ type: "message_stop" }) + "\n\n");
  } else {
    // OpenAI / Moonshot SSE chunks.
    for (const tok of STREAM_TOKENS) {
      write(res, "data: " + JSON.stringify({
        id: "chatcmpl-mock-001",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: { content: tok }, finish_reason: null }],
      }) + "\n\n");
    }
    write(res, "data: " + JSON.stringify({
      id: "chatcmpl-mock-001",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    }) + "\n\n");
    write(res, "data: [DONE]\n\n");
  }
  res.end();
}

function write(res: http.ServerResponse, chunk: string): void {
  res.write(chunk);
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let buf = "";
    req.setEncoding("utf8");
    req.on("data", (c) => { buf += c; });
    req.on("end", () => resolve(buf));
    req.on("error", reject);
  });
}

// ─── standalone runner ──────────────────────────────────────────────────────

async function main(): Promise<void> {
  const quiet = process.argv.includes("--quiet");
  const handle = await startMockServer({ quiet });
  // Machine-readable port line on stdout (wrapper scripts read this).
  process.stdout.write(`MOCK_LLM_PORT=${handle.port}\n`);
  // Park the process; live until SIGINT / SIGTERM.
  const shutdown = (sig: NodeJS.Signals): void => {
    handle.close().then(() => process.exit(0)).catch(() => process.exit(1));
    void sig;
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  await new Promise(() => { /* never resolves */ });
}

const isDirectInvoke = (() => {
  try {
    const url = new URL(import.meta.url);
    const argv1 = process.argv[1];
    if (!argv1) return false;
    const argvUrl = new URL(`file://${argv1.startsWith("/") ? argv1 : "/" + argv1}`);
    return url.pathname === argvUrl.pathname;
  } catch { return false; }
})();

if (isDirectInvoke) {
  main().catch((err) => {
    process.stderr.write(`mock-llm-server failed: ${(err as Error).message}\n`);
    process.exit(1);
  });
}
