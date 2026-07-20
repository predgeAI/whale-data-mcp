#!/usr/bin/env node
/**
 * stdio entrypoint. An agent operator adds this to their MCP client config:
 *
 *   {
 *     "mcpServers": {
 *       "predge-whale-data": {
 *         "command": "npx",
 *         "args": ["-y", "@predge/whale-data-mcp"],
 *         "env": { "BUYER_PRIVATE_KEY": "0x…", "X402_NETWORK": "base-sepolia" }
 *       }
 *     }
 *   }
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer } from "./server.js";

async function main(): Promise<void> {
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr is safe for logs on stdio (stdout is the MCP channel).
  console.error("predge-whale-data MCP server ready (stdio)");
}

main().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
