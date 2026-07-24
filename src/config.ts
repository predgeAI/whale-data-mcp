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

// --- Solana rail (optional, additive) ------------------------------------
const SOLANA_NETWORK_ALIASES: Record<string, string> = {
  // Human name → CAIP-2 (reference = first 32 chars of the genesis hash, case-sensitive).
  solana: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  "solana-devnet": "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
};

function solanaCaip2(raw: string): string {
  const v = raw.trim();
  if (v.toLowerCase().startsWith("solana:")) return `solana:${v.slice("solana:".length)}`;
  const m = SOLANA_NETWORK_ALIASES[v.toLowerCase()];
  if (!m) throw new Error(`Unsupported X402_SOLANA_NETWORK "${raw}" (use solana | solana-devnet | solana:<genesis>)`);
  return m;
}

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function decodeBase58(s: string): Uint8Array {
  let n = 0n;
  for (const ch of s) {
    const i = BASE58.indexOf(ch);
    if (i < 0) throw new Error(`SOLANA_BUYER_SECRET: invalid base58 character "${ch}"`);
    n = n * 58n + BigInt(i);
  }
  const out: number[] = [];
  for (let m = n; m > 0n; m >>= 8n) out.unshift(Number(m & 0xffn));
  for (const ch of s) {
    if (ch !== "1") break;
    out.unshift(0); // leading '1' → leading zero byte
  }
  return Uint8Array.from(out);
}

/**
 * Parse a Solana buyer secret from either a 64-number JSON array (Solana CLI
 * keypair file format) or a base58 string (e.g. a Phantom export). Must decode
 * to exactly 64 bytes (ed25519 secret key). Returns undefined when unset so the
 * Solana rail is purely opt-in.
 */
function parseSolanaSecret(raw?: string): Uint8Array | undefined {
  const t = raw?.trim();
  if (!t) return undefined;
  let bytes: Uint8Array;
  if (t.startsWith("[")) {
    const arr = JSON.parse(t) as unknown;
    if (!Array.isArray(arr)) throw new Error("SOLANA_BUYER_SECRET JSON must be an array of 64 numbers");
    bytes = Uint8Array.from(arr as number[]);
  } else {
    bytes = decodeBase58(t);
  }
  if (bytes.length !== 64) {
    throw new Error(`SOLANA_BUYER_SECRET must decode to a 64-byte Solana secret key, got ${bytes.length} bytes`);
  }
  return bytes;
}

function numEnv(name: string, def: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number, got "${raw}"`);
  return n;
}

const network = caip2(process.env.X402_NETWORK ?? "base");

export const config = {
  baseUrl: (process.env.PREDGE_BASE_URL ?? "https://x402-api-production-266e.up.railway.app").replace(/\/+$/, ""),
  // EVM (Base) buyer. Optional so the server + free discovery tool work without
  // a key; paid tools fail clearly if NO key (EVM or Solana) is set.
  buyerKey: process.env.BUYER_PRIVATE_KEY as `0x${string}` | undefined,
  // Default to Base MAINNET: the live Predge API is mainnet-only, so a
  // one-command install must default here. Override X402_NETWORK=base-sepolia
  // only against a testnet deployment. MAX_PRICE_USD bounds spend either way.
  network,

  // Solana rail — ADDITIVE and opt-in. Set SOLANA_BUYER_SECRET (a funded Solana
  // key, 64-number JSON array or base58) to ALSO be able to pay on Solana; every
  // paid route's 402 offers both Base and Solana, and the client picks whichever
  // network it holds a key for (cheapest when it holds both). The facilitator
  // pays the network fee on Solana too — the buyer needs USDC only.
  solanaBuyerSecret: parseSolanaSecret(process.env.SOLANA_BUYER_SECRET),
  solanaNetwork: solanaCaip2(process.env.X402_SOLANA_NETWORK ?? (network === "eip155:8453" ? "solana" : "solana-devnet")),
  // Optional custom Solana RPC (the public mainnet-beta endpoint is rate-limited).
  solanaRpcUrl: process.env.SOLANA_RPC_URL?.trim() || undefined,

  maxPriceUsd: numEnv("MAX_PRICE_USD", 0.05),
  userAgent: process.env.PREDGE_MCP_USER_AGENT ?? "predge-whale-data-mcp/0.1.1",
} as const;

export const IS_TESTNET = config.network !== "eip155:8453";
