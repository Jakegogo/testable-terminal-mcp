/**
 * MCP server bootstrap — instantiate McpServer, register tools, hook into
 * stdio transport.
 *
 * Stdout reservation: the MCP stdio transport multiplexes JSON-RPC frames on
 * stdout. The logger MUST go to stderr (already enforced in utils/logger.ts);
 * any console.log here would corrupt the transport stream.
 *
 * Lifecycle: caller (bin/mcp-server.ts) creates server + transport, calls
 * server.connect(transport), then awaits process exit. SIGINT / SIGTERM hooks
 * destroy live sessions (see core/process-cleanup.ts).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerAllTools, ToolRegistry } from "./tools.js";

export interface CreateServerOpts {
  name?: string;
  version?: string;
}

export interface ServerHandle {
  server: McpServer;
  registry: ToolRegistry;
  /** Close the transport. */
  close(): Promise<void>;
}

/**
 * Build a server with all tools registered, but don't connect a transport yet.
 * Useful for in-process testing where the test drives the registry directly.
 */
export function createServer(opts: CreateServerOpts = {}): ServerHandle {
  const server = new McpServer(
    {
      name: opts.name ?? "testable-terminal-mcp",
      version: opts.version ?? "0.0.1",
    },
    { capabilities: { tools: {} } },
  );
  const registry = new ToolRegistry();
  registerAllTools(server, registry);
  return {
    server,
    registry,
    close: () => server.close(),
  };
}

/** Connect the server to a fresh stdio transport. Awaits the connection. */
export async function connectStdio(server: McpServer): Promise<StdioServerTransport> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return transport;
}
