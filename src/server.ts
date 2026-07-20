/**
 * Predge Whale Data MCP server. Exposes the 7 paid x402 routes as tools
 * (payment handled under the hood by pay.ts) plus one free discovery tool.
 * Transport-agnostic: index.ts wires it to stdio.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { config, IS_TESTNET } from "./config.js";
import { payGet, freeGet, PaymentError } from "./pay.js";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

function ok(data: unknown, paid: unknown): ToolResult {
  const note = paid
    ? `\n\n_paid via x402: tx ${(paid as { settle_tx?: string }).settle_tx ?? "?"} on ${(paid as { network?: string }).network ?? config.network}_`
    : "";
  const json = JSON.stringify(data, null, 2);
  return {
    content: [{ type: "text", text: (json.length > 12_000 ? json.slice(0, 12_000) + "\n… (truncated)" : json) + note }],
    structuredContent: { data, paid } as Record<string, unknown>,
  };
}

function fail(e: unknown): ToolResult {
  const msg = e instanceof PaymentError ? e.message : e instanceof Error ? e.message : String(e);
  return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
}

async function paid(path: string): Promise<ToolResult> {
  try {
    const { data, paid } = await payGet(path);
    return ok(data, paid);
  } catch (e) {
    return fail(e);
  }
}

const CONDITION_ID = z
  .string()
  .regex(/^[0-9a-zA-Z_:.-]{1,255}$/, "Polymarket conditionId (0x-hex) or platform market id");
const ADDRESS = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "0x-prefixed 40-hex EVM address");

export function buildServer(): McpServer {
  const server = new McpServer(
    { name: "predge-whale-data", version: "0.1.0" },
    {
      instructions:
        "Polymarket whale trades and smart-money signals from Predge, sold per call over x402. " +
        `Tools pay USDC automatically on ${IS_TESTNET ? "Base Sepolia testnet" : "Base mainnet"} from the ` +
        "configured buyer key (max $" + config.maxPriceUsd.toFixed(3) + "/call). Data is delayed 15 minutes. " +
        "Call predge_list_endpoints first (free) to see prices and schemas.",
    },
  );

  // --- free discovery -----------------------------------------------------
  server.registerTool(
    "predge_list_endpoints",
    {
      title: "List Predge endpoints & prices (free)",
      description:
        "Free. Returns the Predge API description, network, payTo, and every endpoint with its price " +
        "and what it returns. Call this first to see what's available before paying.",
      inputSchema: {},
    },
    async () => {
      try {
        return ok(await freeGet("/"), null);
      } catch (e) {
        return fail(e);
      }
    },
  );

  // --- paid tools (one per route) -----------------------------------------
  server.registerTool(
    "predge_whales_latest",
    {
      title: "Latest whale trades",
      description:
        "PAID (~$0.005). Latest Polymarket whale trades ≥$10k notional (15-min delay): market, side, size, " +
        "price, wallet address + Predge wallet score. Param: limit (1-100, default 50).",
      inputSchema: { limit: z.number().int().min(1).max(100).optional() },
    },
    async ({ limit }) => paid(`/v1/whales/latest${limit ? `?limit=${limit}` : ""}`),
  );

  server.registerTool(
    "predge_whale_market",
    {
      title: "Whale activity for one market",
      description:
        "PAID (~$0.01). 7-day whale activity + aggregates (volume, YES/NO split, net flow, unique wallets) " +
        "for one Polymarket market. Param: condition_id.",
      inputSchema: { condition_id: CONDITION_ID },
    },
    async ({ condition_id }) => paid(`/v1/whales/market/${encodeURIComponent(condition_id)}`),
  );

  server.registerTool(
    "predge_signals_daily",
    {
      title: "24h whale digest",
      description:
        "PAID (~$0.02). 24h digest: top markets by whale volume, net flow, largest single bets, totals.",
      inputSchema: {},
    },
    async () => paid("/v1/signals/daily"),
  );

  server.registerTool(
    "predge_wallets_leaderboard",
    {
      title: "Wallet win-rate leaderboard",
      description:
        "PAID (~$0.01). Top wallets by realized win rate over resolved markets. " +
        "Params: window (7d|30d, default 30d), limit (1-100, default 50).",
      inputSchema: {
        window: z.enum(["7d", "30d"]).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    async ({ window, limit }) => {
      const q = new URLSearchParams();
      if (window) q.set("window", window);
      if (limit) q.set("limit", String(limit));
      const qs = q.toString();
      return paid(`/v1/wallets/leaderboard${qs ? `?${qs}` : ""}`);
    },
  );

  server.registerTool(
    "predge_wallet_profile",
    {
      title: "Wallet profile",
      description:
        "PAID (~$0.01). One wallet's profile: Predge score, win rates (7d/30d), favorite categories, " +
        "last 20 trades (15-min delay). Param: address (0x…).",
      inputSchema: { address: ADDRESS },
    },
    async ({ address }) => paid(`/v1/wallets/${encodeURIComponent(address)}`),
  );

  server.registerTool(
    "predge_markets_movers",
    {
      title: "Largest price movers",
      description:
        "PAID (~$0.005). Largest YES-price moves across active markets (from trade prints). " +
        "Param: window (1h|6h|24h, default 6h).",
      inputSchema: { window: z.enum(["1h", "6h", "24h"]).optional() },
    },
    async ({ window }) => paid(`/v1/markets/movers${window ? `?window=${window}` : ""}`),
  );

  server.registerTool(
    "predge_signals_consensus",
    {
      title: "Smart-money consensus (premium)",
      description:
        "PAID (~$0.03, premium). Per active market with whale activity in 24h: net flow of smart-money " +
        "wallets (score > 70), YES/NO volume, and a direction verdict.",
      inputSchema: {},
    },
    async () => paid("/v1/signals/consensus"),
  );

  return server;
}
