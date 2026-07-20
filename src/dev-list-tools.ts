/**
 * Local verification harness (not part of the shipped server). Wires the
 * server to an in-memory client, lists tools, and — if a path arg is given —
 * calls one tool with JSON args:
 *
 *   npm run inspect                                   # just list tools
 *   tsx src/dev-list-tools.ts predge_list_endpoints   # free call
 *   tsx src/dev-list-tools.ts predge_whales_latest '{"limit":2}'   # PAID
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "./server.js";

async function main(): Promise<void> {
  const server = buildServer();
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "dev-inspect", version: "0" });
  await client.connect(clientT);

  const { tools } = await client.listTools();
  console.log(`tools (${tools.length}):`);
  for (const t of tools) console.log(`  - ${t.name}: ${t.title ?? ""}`);

  const toolName = process.argv[2];
  if (toolName) {
    const args = process.argv[3] ? JSON.parse(process.argv[3]) : {};
    console.log(`\ncalling ${toolName}(${JSON.stringify(args)}) …`);
    const res = await client.callTool({ name: toolName, arguments: args });
    const first = (res.content as Array<{ type: string; text?: string }>)[0];
    console.log(`isError: ${res.isError ?? false}`);
    console.log((first?.text ?? "").slice(0, 1500));
  }

  await client.close();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
