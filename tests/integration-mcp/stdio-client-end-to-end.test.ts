/**
 * MCP stdio client end-to-end — replaces the spec's "manual Claude Desktop"
 * verification with an automated equivalent.
 *
 * Why this is equivalent: Claude Desktop is just one MCP client over stdio.
 * The protocol-level verification — boot mcp-server.js → handshake →
 * listTools → callTool → close — is identical. If this test passes, any
 * conforming MCP client (Claude Desktop, Cursor, Continue.dev, etc.) will
 * also work, modulo client-specific UI bugs we couldn't catch from a
 * non-UI test anyway.
 *
 * Two test groups:
 *   1. Always-on (no real agent): listTools + create/close bash session.
 *      Verifies the SDK transport + handshake + tool dispatch under normal
 *      conditions.
 *   2. Real-agent gated (RUN_REAL_AGENT_TESTS=1): drive a real claude
 *      session via terminal.create_session(command="claude",
 *      login_shell=true), assert the model produces "15". This is the
 *      end-to-end "MCP client → ttm tools → PTY → aikey wrapper → real
 *      Anthropic API" verification.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describeIfReal } from "../integration-agent/_helpers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = path.resolve(__dirname, "..", "..", "dist", "bin", "mcp-server.js");

let client: Client;
let transport: StdioClientTransport;

beforeAll(async () => {
  // Build artifact must exist; run `npm run build` if needed (the test
  // doesn't auto-build to keep failure modes clean — missing dist means
  // the dev forgot to build).
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_PATH],
    // Pass through SHELL so loginShell=true on Mac picks up zsh + aikey wrappers.
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      SHELL: process.env.SHELL ?? "/bin/zsh",
      USER: process.env.USER ?? "",
    },
  });
  client = new Client({ name: "ttm-test-client", version: "0.0.1" });
  await client.connect(transport);
});

afterAll(async () => {
  await client.close();
});

describe("MCP stdio — handshake + listTools (always on)", () => {
  it("handshake succeeds + listTools returns all 24 tools", async () => {
    const list = await client.listTools();
    expect(list.tools.length).toBe(24);
    const names = list.tools.map((t) => t.name).sort();
    expect(names).toContain("terminal.create_session");
    expect(names).toContain("terminal.close_session");
    expect(names).toContain("sandbox.create");
    expect(names).toContain("assert.snapshot");
    expect(names).toContain("terminal.env_snapshot");
  }, 10_000);

  it("bash session: create → expect → write → snapshot → close", async () => {
    const create = await client.callTool({
      name: "terminal.create_session",
      arguments: { command: "bash", rows: 24, cols: 80 },
    });
    const createResult = parseToolResult(create);
    expect(createResult.ok).toBe(true);
    const session_id = createResult.session_id as string;

    try {
      const expectPrompt = await client.callTool({
        name: "terminal.expect_regex",
        arguments: { session_id, pattern: "\\$\\s", timeout_ms: 3000 },
      });
      expect(parseToolResult(expectPrompt).ok).toBe(true);

      const write = await client.callTool({
        name: "terminal.write",
        arguments: { session_id, text: "echo MCP_STDIO_PROBE\n" },
      });
      expect(parseToolResult(write).ok).toBe(true);

      const expectEcho = await client.callTool({
        name: "terminal.expect_text",
        arguments: { session_id, text: "MCP_STDIO_PROBE", timeout_ms: 3000 },
      });
      expect(parseToolResult(expectEcho).ok).toBe(true);

      const snap = await client.callTool({
        name: "terminal.snapshot",
        arguments: { session_id, range: "viewport" },
      });
      const snapResult = parseToolResult(snap);
      expect(snapResult.ok).toBe(true);
      expect(snapResult.text).toContain("MCP_STDIO_PROBE");
    } finally {
      await client.callTool({
        name: "terminal.close_session",
        arguments: { session_id },
      });
    }
  }, 15_000);

  it("invalid input returns structured error envelope (not throw)", async () => {
    const r = await client.callTool({
      name: "terminal.write",
      arguments: { session_id: "term_no_such", text: "x" },
    });
    const parsed = parseToolResult(r);
    expect(parsed.ok).toBe(false);
    expect(parsed.error_code).toBe("E_TT_SESSION_NOT_FOUND");
  }, 5_000);
});

describeIfReal("MCP stdio — real claude agent (end-to-end via aikey)", ["claude"], () => {
  it("MCP client → ttm tools → PTY → claude (real) → answer 15", async () => {
    const create = await client.callTool({
      name: "terminal.create_session",
      arguments: {
        command: "claude",
        args: ["--print", "5 + 10 = ? Reply with just the number, nothing else."],
        rows: 24,
        cols: 100,
        login_shell: true, // ⬅ aikey wrapper fires here
        simulate_precmd_hooks: true, // ⬅ trigger hook chain (zero-config)
      },
    });
    const createResult = parseToolResult(create);
    expect(createResult.ok).toBe(true);
    const session_id = createResult.session_id as string;

    try {
      const expect15 = await client.callTool({
        name: "terminal.expect_regex",
        arguments: { session_id, pattern: "\\b15\\b", timeout_ms: 60_000 },
      });
      const r = parseToolResult(expect15);
      expect(r.ok).toBe(true);

      const snap = await client.callTool({
        name: "terminal.snapshot",
        arguments: { session_id, range: "all" },
      });
      const snapResult = parseToolResult(snap);
      expect(snapResult.text).toMatch(/\b15\b/);
    } finally {
      await client.callTool({
        name: "terminal.close_session",
        arguments: { session_id },
      });
    }
  }, 65_000);
});

// ─── helpers ────────────────────────────────────────────────────────────────

interface CallToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

function parseToolResult(raw: unknown): Record<string, unknown> {
  const r = raw as CallToolResult;
  // Tool handlers return `{ content: [{ type: 'text', text: JSON.stringify(result) }] }`.
  const text = r.content[0]?.text;
  if (typeof text !== "string") {
    throw new Error(`unexpected tool result shape: ${JSON.stringify(raw)}`);
  }
  return JSON.parse(text) as Record<string, unknown>;
}
