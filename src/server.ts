/**
 * Predge Whale Data MCP server. Exposes the paid x402 routes as tools
 * (payment handled under the hood by pay.ts) plus free discovery, settlement-risk,
 * verdict re-read and offline-verification tools. Signed records share one ed25519
 * primitive: predge_attest (resolved Polymarket outcome), predge_sports_attest
 * (settled game result), the settlement-risk records and the delivery verdicts
 * (predge_verdict: was the paid job delivered?). Routes the API has paused
 * (503 signed_wallet_outputs_paused: wallet attest, pm-activity, pm-flows,
 * /v1/signal) have no tool.
 * Transport-agnostic: index.ts wires it to stdio.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { config, IS_TESTNET, VERSION, DEFAULT_BASE_URL } from "./config.js";
import { payGet, payPost, freeGet, apiHeaders, PaymentError, PaymentRequiredError, UpstreamError, type KeyInfo } from "./pay.js";
import { extractEnvelope, verifyEnvelope, KEYS_PATH, type PredgeKey } from "./verify.js";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

function ok(data: unknown, paid: unknown, key: KeyInfo | null = null): ToolResult {
  let note = paid
    ? `\n\n_paid via x402: tx ${(paid as { settle_tx?: string }).settle_tx ?? "?"} on ${(paid as { network?: string }).network ?? config.network}_`
    : "";
  if (key?.pilot) note += `\n\n_PREDGE_KEY: ${key.pilot}_`;
  const json = JSON.stringify(data, null, 2);
  const structured: Record<string, unknown> = { data, paid };
  if (key) structured.predge_key = key;
  return {
    content: [{ type: "text", text: (json.length > 12_000 ? json.slice(0, 12_000) + "\n… (truncated)" : json) + note }],
    structuredContent: structured,
  };
}

function fail(e: unknown): ToolResult {
  if (e instanceof PaymentRequiredError) {
    // The API's own 402 explanation (price, networks, how to pay, pilot key), readable as is.
    return {
      content: [{ type: "text", text: `${e.message}\n\n${JSON.stringify(e.details, null, 2)}` }],
      structuredContent: { error: e.details },
      isError: true,
    };
  }
  if (e instanceof UpstreamError) {
    return {
      content: [{ type: "text", text: `Error: ${e.message}` }],
      structuredContent: { error: { status: e.status, body: e.body ?? null } },
      isError: true,
    };
  }
  const msg = e instanceof PaymentError ? e.message : e instanceof Error ? e.message : String(e);
  return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
}

async function paid(path: string): Promise<ToolResult> {
  try {
    const { data, paid, key } = await payGet(path);
    return ok(data, paid, key);
  } catch (e) {
    return fail(e);
  }
}

/** Tools that only make sense with a key: answer locally instead of sending a keyless request. */
function needsKey(tool: string, what: string): ToolResult | null {
  if (config.predgeKey) return null;
  return {
    content: [
      {
        type: "text",
        text:
          `Error: ${tool} needs PREDGE_KEY (${what}). Set PREDGE_KEY in the MCP server env: a free 30-day ` +
          "pilot key is at https://predge.io/start, a Desk key (14-day trial) at https://predge.io/desk.",
      },
    ],
    structuredContent: { error: { error: "key_required", tool } },
    isError: true,
  };
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
    const res = await globalThis.fetch(KEYS_URL, { headers: apiHeaders(), signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return keyCache?.keys ?? null;
    const body = (await res.json()) as { keys?: PredgeKey[] };
    if (!Array.isArray(body.keys)) return keyCache?.keys ?? null;
    keyCache = { at: Date.now(), keys: body.keys };
    return body.keys;
  } catch {
    return keyCache?.keys ?? null;
  }
}

/** Check the attestation envelope of a signed record; never throws. */
async function verified(record: unknown): Promise<unknown> {
  try {
    return verifyEnvelope(extractEnvelope(record), await predgeKeys());
  } catch (e) {
    return { valid: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// Know-your-agent identity, exactly the API's shape (signed into the verdict, not verified by Predge).
const AGENT_IDENTITY = z
  .object({
    id: z.string().min(1).max(256).describe("e.g. an ERC-8004 agent id such as eip155:8453:0x8004...:123, or any stable string"),
    version: z.string().min(1).max(64),
    operator: z.string().min(1).max(256).describe("company or wallet accountable for the agent"),
    authorization_ref: z.string().min(1).max(256).optional().describe("optional mandate / policy / authorization id"),
  })
  .strict();

const SHA256 = z.string().regex(/^[0-9a-fA-F]{64}$/, "64 hex characters");
const DOT_PATHS = z.array(z.string().min(1).max(200)).max(50);

const VERDICT_INPUT = {
  job: z
    .object({
      endpoint: z.string().min(1).max(2048).describe("the URL or path that was called (required)"),
      method: z.string().min(1).max(16).optional(),
      expected_content_type: z.string().min(1).max(128).optional(),
      expect_json: z.boolean().optional(),
      json_schema: z
        .union([z.record(z.string(), z.unknown()), z.boolean()])
        .optional()
        .describe("JSON Schema the body must match"),
      required_fields: DOT_PATHS.optional().describe("dot-paths that must be present"),
      non_empty_fields: DOT_PATHS.optional().describe("dot-paths that must be non-empty"),
      max_latency_ms: z.number().int().min(0).max(3_600_000).optional(),
      expected_sha256: SHA256.optional(),
    })
    .describe("What was promised."),
  delivery: z
    .object({
      status: z.number().int().min(100).max(599).optional().describe("HTTP status the service returned"),
      headers: z.record(z.string(), z.string().max(512)).optional().describe("subset of response headers (max 30)"),
      body: z
        .union([z.string(), z.record(z.string(), z.unknown()), z.array(z.unknown())])
        .optional()
        .describe("response body (max 200k chars); or send body_sha256"),
      body_sha256: SHA256.optional(),
      latency_ms: z.number().int().min(0).max(86_400_000).optional(),
      requested_at: z.string().max(40).optional().describe("ISO 8601"),
      responded_at: z.string().max(40).optional().describe("ISO 8601"),
    })
    .describe("The delivery evidence."),
  payment: z
    .object({
      amount_usd: z
        .number()
        .min(0)
        .max(1_000_000_000)
        .describe("USD paid for the job: under 1 uses POST /v1/verdicts ($0.05), 1 or more uses /v1/verdicts/large ($0.50)"),
      tx_hash: z.string().min(1).max(200).optional(),
      network: z.string().min(1).max(200).optional(),
      asset: z.string().min(1).max(200).optional(),
      payer: z.string().min(1).max(200).optional(),
      payee: z.string().min(1).max(200).optional(),
    })
    .describe("The payment reference."),
  buyer_id: z.string().min(1).max(128).optional(),
  merchant_id: z.string().min(1).max(128).optional(),
  agent: AGENT_IDENTITY.optional().describe(
    "The buyer agent (know your agent): id, version, operator, optional authorization_ref.",
  ),
  provider_agent: AGENT_IDENTITY.optional().describe("The provider (merchant) agent, same shape."),
};

const VERDICT_ID = z.string().regex(/^vrd_[A-Za-z0-9_-]{24}$/, "verdict id: vrd_ + 24 base64url characters");

const ADDRESS = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "0x-prefixed 40-hex EVM address");

export function buildServer(): McpServer {
  const server = new McpServer(
    { name: "predge-whale-data", version: VERSION },
    {
      instructions:
        "Predge: delivery verdicts for AI-agent payments, plus Polymarket whale trades and smart-money signals, " +
        "sold per call over x402. predge_verdict answers 'was the paid job delivered?' with a signed verdict " +
        "(delivered | not_delivered | inconclusive), per-check results and a refund recommendation; " +
        "predge_get_verdict re-reads one for free. Signed records verify OFFLINE against Predge's published key: " +
        "predge_attest (resolved Polymarket outcome), predge_sports_attest (settled game result, winner/score), " +
        "settlement-risk records and verdicts. If PREDGE_KEY is set it is sent on every call (a pilot key makes " +
        "the settlement estimate and verdicts free for 30 days). " +
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
        return ok({ verification: await verified(record), record }, null);
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
        "settlement_estimate_available before paying. With PREDGE_KEY set to a pilot key from " +
        "https://predge.io/start it is free for 30 days. Param: market (condition id 0x+64 hex, numeric market id, or slug).",
      inputSchema: { market: SETTLEMENT_MARKET },
    },
    async ({ market }) => {
      try {
        const { data: record, paid: receipt, key } = await payGet(
          `/v1/settlement-risk/${encodeURIComponent(market)}/estimate`,
        );
        return ok({ verification: await verified(record), record }, receipt, key);
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
        "responses from predge_settlement_risk, predge_attest, predge_sports_attest, " +
        "predge_verdict, predge_get_verdict, or a bare `attestation` envelope. Param: record (the JSON, as a string).",
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


  // --- delivery verdicts: was the paid job delivered? ----------------------
  server.registerTool(
    "predge_verdict",
    {
      title: "Delivery verdict — was the paid job delivered? (signed)",
      description:
        "PAID: $0.05 when payment.amount_usd < 1 (POST /v1/verdicts), $0.50 when >= 1 (POST /v1/verdicts/large); " +
        "the tool picks the route. FREE with PREDGE_KEY set to a pilot key (https://predge.io/start) inside its " +
        "30-day window. Send what was promised (job: endpoint, expected content type, JSON Schema, required " +
        "fields, max latency, expected sha256), the delivery evidence (status, headers, body or body_sha256, " +
        "timing) and the payment reference (amount_usd, tx_hash, network, payer, payee), optionally the buyer " +
        "and provider agent identities (id, version, operator, authorization_ref). Returns an ed25519-signed " +
        "verdict (delivered | not_delivered | inconclusive), per-check results, reason codes and a refund " +
        "RECOMMENDATION (the merchant honours it; nothing is refunded automatically). Deterministic checks, " +
        "no LLM. The tool re-checks the signature and returns `{ verification, record }`; re-read later for " +
        "free with predge_get_verdict. Paying the $0.50 tier over x402 needs MAX_PRICE_USD >= 0.5. Without " +
        "a key or buyer wallet the result is the API's 402 explanation (price and how to pay).",
      inputSchema: VERDICT_INPUT,
    },
    async (args) => {
      try {
        const route = args.payment.amount_usd < 1 ? "/v1/verdicts" : "/v1/verdicts/large";
        const { data: record, paid: receipt, key } = await payPost(route, args);
        return ok({ verification: await verified(record), record }, receipt, key);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "predge_get_verdict",
    {
      title: "Read a signed delivery verdict by id (free)",
      description:
        "FREE, no payment. GET /v1/verdicts/:id: the stored signed verdict issued by predge_verdict, " +
        "byte-identical in content. The tool re-checks the ed25519 signature and returns " +
        "`{ verification, record }`. 404 verdict_not_found for an unknown id. Param: id (vrd_ + 24 characters).",
      inputSchema: { id: VERDICT_ID },
    },
    async ({ id }) => {
      try {
        const record = await freeGet(`/v1/verdicts/${encodeURIComponent(id)}`);
        return ok({ verification: await verified(record), record }, null);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "predge_verdict_report",
    {
      title: "Monthly signed dispute-handling report (needs PREDGE_KEY)",
      description:
        "FREE for a key holder, counts as one call against the key's daily quota. GET /v1/verdicts/report: " +
        "the verdicts requested with PREDGE_KEY in one UTC month (optionally one merchant_id): counts by " +
        "outcome, refund recommendations (count, total USD), top reason codes, median/p95 time to verdict, " +
        "verdict ids with verify URLs (paginated, next_cursor), a sample and the methodology. Signed; the tool " +
        "re-checks the signature. Params: month (YYYY-MM), merchant_id, limit (1-1000, default 100), cursor, " +
        "sample (0-20, default 5).",
      inputSchema: {
        month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "UTC calendar month, YYYY-MM"),
        merchant_id: z.string().min(1).max(128).optional(),
        limit: z.number().int().min(1).max(1000).optional(),
        cursor: z.string().min(1).max(512).optional(),
        sample: z.number().int().min(0).max(20).optional(),
      },
    },
    async ({ month, merchant_id, limit, cursor, sample }) => {
      const missing = needsKey("predge_verdict_report", "the report covers only the verdicts that key requested");
      if (missing) return missing;
      try {
        const q = new URLSearchParams({ month });
        if (merchant_id) q.set("merchant_id", merchant_id);
        if (limit !== undefined) q.set("limit", String(limit));
        if (cursor) q.set("cursor", cursor);
        if (sample !== undefined) q.set("sample", String(sample));
        const record = await freeGet(`/v1/verdicts/report?${q.toString()}`);
        return ok({ verification: await verified(record), record }, null);
      } catch (e) {
        return fail(e);
      }
    },
  );

  // --- key holders: plan/quota and Desk -------------------------------------
  server.registerTool(
    "predge_key_status",
    {
      title: "PREDGE_KEY status: plan, quota, expiry (needs PREDGE_KEY)",
      description:
        "FREE. GET /v1/me with PREDGE_KEY: the key's plan, daily quota and use, and when the pilot window ends.",
      inputSchema: {},
    },
    async () => {
      const missing = needsKey("predge_key_status", "it reports on that key");
      if (missing) return missing;
      try {
        return ok(await freeGet("/v1/me"), null);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "predge_desk_config",
    {
      title: "Desk config: watched wallets and alert targets (needs a Desk key)",
      description:
        "FREE with a Desk key in PREDGE_KEY (https://predge.io/desk, 14-day trial). GET /v1/desk/config: the " +
        "Polymarket wallets the Desk watches, where settlement alerts go (webhook, Telegram) and the plan " +
        "status (trial, paid_until). Read only.",
      inputSchema: {},
    },
    async () => {
      const missing = needsKey("predge_desk_config", "a Desk key");
      if (missing) return missing;
      try {
        return ok(await freeGet("/v1/desk/config"), null);
      } catch (e) {
        return fail(e);
      }
    },
  );

  return server;
}
