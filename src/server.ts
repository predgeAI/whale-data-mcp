/**
 * Predge Whale Data MCP server. Exposes the paid x402 routes as tools
 * (payment handled under the hood by pay.ts) plus one free discovery tool.
 * The flagships are the signed attestations — one ed25519 primitive across four
 * verticals: predge_attest (resolved Polymarket outcome), predge_sports_attest
 * (settled game result), predge_kalshi_attest (settled Kalshi resolution) and
 * predge_wallet_attest (a wallet's win/loss track record). Predge's
 * differentiating primitive: verify a claim/bet/win-rate against tamper-evident,
 * offline-checkable settled truth.
 * Transport-agnostic: index.ts wires it to stdio.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { config, IS_TESTNET, VERSION, DEFAULT_BASE_URL } from "./config.js";
import { payGet, freeGet, PaymentError } from "./pay.js";
import { extractEnvelope, verifyEnvelope, KEYS_PATH, type PredgeKey } from "./verify.js";

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
// Polymarket condition id (0x + 64 hex), numeric market id, or market slug.
const SETTLEMENT_MARKET = z
  .string()
  .regex(/^(0x[0-9a-fA-F]{64}|\d{1,12}|[a-z0-9][a-z0-9-]{0,200})$/, "condition id (0x+64 hex), market id or slug");

// The Predge key set is always read from the canonical host, even when
// PREDGE_BASE_URL points elsewhere: it decides whose signature counts.
const KEYS_URL = `${DEFAULT_BASE_URL}${KEYS_PATH}`;
let keyCache: { at: number; keys: PredgeKey[] } | null = null;
async function predgeKeys(): Promise<PredgeKey[] | null> {
  if (keyCache && Date.now() - keyCache.at < 10 * 60_000) return keyCache.keys;
  try {
    const res = await fetch(KEYS_URL, { headers: { "user-agent": config.userAgent }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return keyCache?.keys ?? null;
    const body = (await res.json()) as { keys?: PredgeKey[] };
    if (!Array.isArray(body.keys)) return keyCache?.keys ?? null;
    keyCache = { at: Date.now(), keys: body.keys };
    return body.keys;
  } catch {
    return keyCache?.keys ?? null;
  }
}

const ADDRESS = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "0x-prefixed 40-hex EVM address");

export function buildServer(): McpServer {
  const server = new McpServer(
    { name: "predge-whale-data", version: VERSION },
    {
      instructions:
        "Polymarket whale trades and smart-money signals from Predge, sold per call over x402. " +
        "Flagships — one ed25519 signing primitive across four verticals, all verifiable OFFLINE " +
        "against Predge's published key: predge_attest (resolved Polymarket outcome), " +
        "predge_sports_attest (settled game result, winner/score), predge_kalshi_attest (settled Kalshi " +
        "market resolution) and predge_wallet_attest (a wallet's signed win/loss track record). Use them " +
        "to check whether a past signal, call, bet, or win-rate claim was actually right, or to settle/" +
        "ground a wager on tamper-evident truth. " +
        `Tools pay USDC automatically on ${IS_TESTNET ? "Base Sepolia testnet" : "Base mainnet"} from the ` +
        "configured buyer key (max $" + config.maxPriceUsd.toFixed(3) + "/call). Data is delayed 15 minutes. " +
        "Call predge_list_endpoints first (free) to see prices and schemas. " +
        "Free and signed: predge_settlement_risk (live UMA dispute/settlement risk for a Polymarket market); " +
        "predge_verify_record checks any Predge signed record offline.",
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
        "PAID (~$0.01). Top wallets over resolved markets, ranked by edge (win rate vs. entry price), not raw win rate. " +
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

  // --- flagship: resolved-outcome attestation -----------------------------
  server.registerTool(
    "predge_attest",
    {
      title: "Outcome attestation — verified settled truth (flagship)",
      description:
        "PAID (~$0.02). Resolved-outcome ATTESTATION for one Polymarket market: the SETTLED truth " +
        "straight off the market row — resolved (bool), resolution (yes|no|null), resolved_at, and " +
        "outcome_verified:{resolution:true}. Pure outcome-verified data — no modeled estimate anywhere. " +
        "Optional side (yes|no): adds queried_side and correct (true iff side matches the resolved " +
        "outcome) — use it to VERIFY whether a past signal, call, or advertised win-rate was actually " +
        "right. Unknown/unresolvable market returns null and is NOT charged. Params: condition_id, side.",
      inputSchema: {
        condition_id: CONDITION_ID,
        side: z.enum(["yes", "no"]).optional(),
      },
    },
    async ({ condition_id, side }) =>
      paid(`/v1/attest/${encodeURIComponent(condition_id)}${side ? `?side=${side}` : ""}`),
  );

  // --- flagship (sports vertical): signed settled game outcome -------------
  server.registerTool(
    "predge_sports_attest",
    {
      title: "Sports outcome attestation — signed settled game result (flagship)",
      description:
        "PAID (~$0.02). Ed25519-SIGNED settled game outcome for one finished match — winner, final " +
        "score, completed(bool), teams, scheduled time — sourced from ESPN and signed with Predge's " +
        "published key, so it VERIFIES OFFLINE (no trust in this API): re-check the signature against " +
        "the pubkey at data.predge.io/.well-known/predge-attest.json. Use it to settle bets, prove a " +
        "track record, or ground a wager on a tamper-evident result. Optional winner (team abbreviation " +
        "e.g. 'LAL'): adds queried_winner and correct (true iff it matches the settled winner). Unknown " +
        "league or unfinished/unknown event returns null and is NOT charged. " +
        "Leagues: nba, wnba, nfl, college-football, mlb, nhl, mls, epl, champions-league, laliga. " +
        "Params: league, event_id (provider event id), winner.",
      inputSchema: {
        league: z.enum([
          "nba",
          "wnba",
          "nfl",
          "college-football",
          "mlb",
          "nhl",
          "mls",
          "epl",
          "champions-league",
          "laliga",
        ]),
        event_id: z.string().regex(/^[0-9A-Za-z._-]{1,64}$/, "provider event id"),
        winner: z.string().min(1).max(16).optional(),
      },
    },
    async ({ league, event_id, winner }) =>
      paid(
        `/v1/sports/attest/${encodeURIComponent(league)}/${encodeURIComponent(event_id)}${
          winner ? `?winner=${encodeURIComponent(winner)}` : ""
        }`,
      ),
  );

  // --- flagship (kalshi): signed settled market resolution ----------------
  server.registerTool(
    "predge_kalshi_attest",
    {
      title: "Kalshi outcome attestation — signed settled market resolution (flagship)",
      description:
        "PAID (~$0.02). Ed25519-SIGNED settled resolution for one Kalshi market — resolved(bool), " +
        "resolution (yes|no|null), resolved_at — sourced from Kalshi's public market API and signed " +
        "with Predge's published key, so it VERIFIES OFFLINE (no trust in this API): re-check the " +
        "signature against the pubkey at data.predge.io/.well-known/predge-attest.json. This attests " +
        "the MARKET's own settled result, NOT trader data. Optional side (yes|no): adds queried_side " +
        "and correct (true iff it matches the resolution, null while unsettled). A market that has not " +
        "settled yet returns resolved:false; an unknown ticker returns null and is NOT charged. " +
        "Params: ticker (Kalshi market ticker), side.",
      inputSchema: {
        ticker: z.string().regex(/^[0-9A-Za-z._-]{1,128}$/, "Kalshi market ticker"),
        side: z.enum(["yes", "no"]).optional(),
      },
    },
    async ({ ticker, side }) =>
      paid(`/v1/kalshi/attest/${encodeURIComponent(ticker)}${side ? `?side=${side}` : ""}`),
  );

  // --- flagship (wallet track-record): signed win/loss record -------------
  server.registerTool(
    "predge_wallet_attest",
    {
      title: "Wallet track-record attestation — signed win/loss record (flagship)",
      description:
        "PAID (~$0.02). Ed25519-SIGNED track record for one wallet over RESOLVED Polymarket markets — " +
        "the wallet's outcome-verified win/loss record signed with Predge's published key, so it " +
        "VERIFIES OFFLINE against the pubkey at data.predge.io/.well-known/predge-attest.json. Turns a " +
        "self-reported win rate into signed, tamper-evident proof a third party can check. Param: " +
        "window (7d|30d, default 30d). A wallet with no resolved trades in the window returns 404 and " +
        "is NOT charged. Params: address (0x…), window.",
      inputSchema: {
        address: ADDRESS,
        window: z.enum(["7d", "30d"]).optional(),
      },
    },
    async ({ address, window }) =>
      paid(`/v1/wallets/${encodeURIComponent(address)}/attest${window ? `?window=${window}` : ""}`),
  );

  // --- full route parity (the rest of the paid Polymarket surface) --------
  server.registerTool(
    "predge_bets_biggest",
    {
      title: "Biggest single bets",
      description:
        "PAID (~$0.005). Top-20 largest single trades across all Polymarket markets in the window " +
        "(market, side, size, price, wallet + score). Param: window (24h|7d, default 24h).",
      inputSchema: { window: z.enum(["24h", "7d"]).optional() },
    },
    async ({ window }) => paid(`/v1/bets/biggest${window ? `?window=${window}` : ""}`),
  );

  server.registerTool(
    "predge_signals_daily_category",
    {
      title: "24h digest for one category",
      description:
        "PAID (~$0.01). The 24h whale digest scoped to one market category (e.g. politics, economics, " +
        "sports). Unknown category → 404 (not charged) with the known_categories list. Param: category.",
      inputSchema: { category: z.string().min(1).max(64) },
    },
    async ({ category }) => paid(`/v1/signals/daily/${encodeURIComponent(category)}`),
  );

  server.registerTool(
    "predge_signals_consensus_category",
    {
      title: "Smart-money consensus for one category",
      description:
        "PAID (~$0.02). Edge-verified smart-money consensus (net flow + direction) scoped to one " +
        "category. Unknown category → 404 (not charged) with known_categories. Param: category.",
      inputSchema: { category: z.string().min(1).max(64) },
    },
    async ({ category }) => paid(`/v1/signals/consensus/${encodeURIComponent(category)}`),
  );

  server.registerTool(
    "predge_signals_market",
    {
      title: "Single-market smart-money verdict",
      description:
        "PAID (~$0.01). Single-market smart-money VERDICT — the \"should you trust this move?\" decision " +
        "for one market: edge-verified smart flow, direction and confidence. Param: condition_id.",
      inputSchema: { condition_id: CONDITION_ID },
    },
    async ({ condition_id }) => paid(`/v1/signals/market/${encodeURIComponent(condition_id)}`),
  );

  server.registerTool(
    "predge_wallet_history",
    {
      title: "Wallet trade history + PnL curve",
      description:
        "PAID (~$0.02). One wallet's trade history with a running win-rate and modeled-PnL curve. " +
        "Params: address (0x…), window (30d|90d|all, default 30d).",
      inputSchema: { address: ADDRESS, window: z.enum(["30d", "90d", "all"]).optional() },
    },
    async ({ address, window }) =>
      paid(`/v1/wallets/${encodeURIComponent(address)}/history${window ? `?window=${window}` : ""}`),
  );

  server.registerTool(
    "predge_wallets_compare",
    {
      title: "Compare wallets side-by-side",
      description:
        "PAID (~$0.02). Side-by-side comparison of 2-10 wallets (scores, win rates, modeled PnL) plus " +
        "their market overlap. Param: addresses (2-10 0x… addresses).",
      inputSchema: { addresses: z.array(ADDRESS).min(2).max(10) },
    },
    async ({ addresses }) =>
      paid(`/v1/wallets/compare?addresses=${addresses.map(encodeURIComponent).join(",")}`),
  );

  server.registerTool(
    "predge_market_history",
    {
      title: "Market price/volume history",
      description:
        "PAID (~$0.01). Price/volume history for one Polymarket market in daily buckets (price " +
        "normalized to the YES side) plus recent prints. Params: condition_id, window (7d|30d|all, default 30d).",
      inputSchema: { condition_id: CONDITION_ID, window: z.enum(["7d", "30d", "all"]).optional() },
    },
    async ({ condition_id, window }) =>
      paid(`/v1/markets/${encodeURIComponent(condition_id)}/history${window ? `?window=${window}` : ""}`),
  );

  // --- free: signed live UMA settlement risk --------------------------------
  server.registerTool(
    "predge_settlement_risk",
    {
      title: "Settlement risk — signed live UMA dispute status (free)",
      description:
        "FREE, no key or payment. Live UMA settlement risk for one Polymarket market, read from UMA's " +
        "Optimistic Oracle and Polymarket's UMA CTF adapter on Polygon: uma_state, current proposal and " +
        "challenge window, every dispute, whether it went to a UMA vote, bulletin-board updates, on-chain " +
        "resolution, risk_level (ok|watch|caution|resolved) with a one-line recommendation, plus the " +
        "segment_dispute_rate statistic and a settlement_estimate_available flag. The settlement_estimate " +
        "itself is NOT in this free record: it is sold by predge_settlement_estimate " +
        "(GET /v1/settlement-risk/:market/estimate, ~$0.02). The record is ed25519-signed " +
        "(predge-attest-v1); this tool re-checks the signature, content hash and signer key and returns " +
        "the result under `verification`. A dispute blocks a proposal; it does not by itself change the " +
        "outcome. 404 unknown_market and 422 unsupported_* are NOT 'no risk' answers. Rate limit 60/min per IP. " +
        "Param: market (condition id 0x+64 hex, numeric market id, or slug).",
      inputSchema: { market: SETTLEMENT_MARKET },
    },
    async ({ market }) => {
      try {
        const record = await freeGet(`/v1/settlement-risk/${encodeURIComponent(market)}`);
        let verification: unknown;
        try {
          verification = verifyEnvelope(extractEnvelope(record), await predgeKeys());
        } catch (e) {
          verification = { valid: false, error: e instanceof Error ? e.message : String(e) };
        }
        return ok({ verification, record }, null);
      } catch (e) {
        return fail(e);
      }
    },
  );

  // --- paid: signed settlement-risk record WITH settlement_estimate ---------
  server.registerTool(
    "predge_settlement_estimate",
    {
      title: "Settlement risk + settlement_estimate — signed (paid)",
      description:
        "PAID (~$0.02 via x402). The same signed live UMA settlement-risk record as the free " +
        "predge_settlement_risk tool, WITH settlement_estimate: a statistic computed from 2026 Polymarket " +
        "UMA disputes (market price before the first dispute + market type). A statistic, not advice. " +
        "GET /v1/settlement-risk/:market/estimate. The tool re-checks the ed25519 signature and returns " +
        "`{ verification, record }`. Call predge_settlement_risk first (free) and check " +
        "settlement_estimate_available before paying. Param: market (condition id 0x+64 hex, numeric market id, or slug).",
      inputSchema: { market: SETTLEMENT_MARKET },
    },
    async ({ market }) => {
      try {
        const { data: record, paid: receipt } = await payGet(
          `/v1/settlement-risk/${encodeURIComponent(market)}/estimate`,
        );
        let verification: unknown;
        try {
          verification = verifyEnvelope(extractEnvelope(record), await predgeKeys());
        } catch (e) {
          verification = { valid: false, error: e instanceof Error ? e.message : String(e) };
        }
        return ok({ verification, record }, receipt);
      } catch (e) {
        return fail(e);
      }
    },
  );

  // --- free: offline signature check for any Predge signed record ----------
  server.registerTool(
    "predge_verify_record",
    {
      title: "Verify a Predge signed record (free, offline)",
      description:
        "FREE. Checks a Predge signed record (predge-attest-v1) without trusting the API: payload " +
        "re-canonicalises to `canonical`, sha256(canonical) == content_hash, ed25519 signature over " +
        "canonical, envelope_signature when present, and that public_key is an active key in " +
        "api.predge.io/.well-known/predge-keys.json (the only network call; it is cached). Works on " +
        "responses from predge_settlement_risk, predge_attest, predge_sports_attest, predge_kalshi_attest, " +
        "predge_wallet_attest, or a bare `attestation` envelope. Param: record (the JSON, as a string).",
      inputSchema: { record: z.string().min(2).max(1_000_000) },
    },
    async ({ record }) => {
      try {
        return ok(verifyEnvelope(extractEnvelope(record), await predgeKeys()), null);
      } catch (e) {
        return fail(e);
      }
    },
  );

  return server;
}
