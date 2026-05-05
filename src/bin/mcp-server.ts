#!/usr/bin/env node
/**
 * testable-terminal-mcp — MCP server entry point.
 *
 * Speaks JSON-RPC over stdio. Use it from Claude Desktop / Cursor / any
 * MCP-compatible client by adding to your client's config:
 *
 *   {
 *     "mcpServers": {
 *       "testable-terminal-mcp": {
 *         "command": "npx",
 *         "args": ["-y", "testable-terminal-mcp"]
 *       }
 *     }
 *   }
 *
 * Or run directly: `node dist/bin/mcp-server.js`.
 *
 * No CLI flags — all configuration is via environment variables (TT_*) and
 * config files (see core/config.ts).
 */

import { logger } from "../utils/logger.js";
import { connectStdio, createServer } from "../adapters/mcp/server.js";

async function main(): Promise<void> {
  const handle = createServer();
  await connectStdio(handle.server);
  logger.info("mcp.connected", { tools: 24 });
  // Lifetime: live until stdin closes (StdioServerTransport observes that).
  // Keep the process alive — connect() doesn't, by itself, prevent exit on
  // some Node configurations.
  await new Promise(() => { /* never resolves */ });
}

main().catch((err) => {
  logger.error("mcp.fatal", { error: (err as Error).message, stack: (err as Error).stack });
  process.exit(1);
});
