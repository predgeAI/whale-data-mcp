const NETWORK_ALIASES: Record<string, string> = {
  "base-sepolia": "eip155:84532",
  base: "eip155:8453",
};

function caip2(raw: string): string {
  const v = raw.trim().toLowerCase();
  if (v.startsWith("eip155:")) return v;
  const m = NETWORK_ALIASES[v];
  if (!m) throw new Error(`Unsupported X402_NETWORK "${raw}" (use base-sepolia | base | eip155:<id>)`);
  return m;
}

function numEnv(name: string, def: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number, got "${raw}"`);
  return n;
}

export const config = {
  baseUrl: (process.env.PREDGE_BASE_URL ?? "https://x402-api-production-266e.up.railway.app").replace(/\/+$/, ""),
  // Optional so the server + free discovery tool work without a key; paid
  // tools fail clearly if it's unset.
  buyerKey: process.env.BUYER_PRIVATE_KEY as `0x${string}` | undefined,
  // Default to Base MAINNET: the live Predge API is mainnet-only, so a
  // one-command install must default here or every paid tool would fail the
  // network guard. Override X402_NETWORK=base-sepolia only against a testnet
  // deployment. The MAX_PRICE_USD cap (below) bounds spend either way.
  network: caip2(process.env.X402_NETWORK ?? "base"),
  maxPriceUsd: numEnv("MAX_PRICE_USD", 0.05),
  userAgent: process.env.PREDGE_MCP_USER_AGENT ?? "predge-whale-data-mcp/0.1.1",
} as const;

export const IS_TESTNET = config.network !== "eip155:8453";
