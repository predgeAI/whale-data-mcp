# @predge/whale-data-mcp

MCP server that exposes the **Predge** API at `https://api.predge.io`
(signed delivery verdicts for AI-agent payments, Polymarket whale trades,
smart-money signals, signed attestations, and free signed UMA settlement risk)
as tools. Payment is handled **under the hood**:
each paid tool call signs a USDC micropayment via an x402 client — the agent
just calls the tool and gets data back. You supply a funded buyer key.

> **Defaults to Base mainnet** (the live Predge API is mainnet-only). Paid tools
> spend **real USDC** — typically $0.005–$0.03/call, hard-capped at
> `MAX_PRICE_USD` ($0.05 by default) *before* any money moves. Use a dedicated,
> low-balance buyer wallet.

## Install (one command)

**Claude Code:**

```bash
claude mcp add predge-whale-data \
  -e BUYER_PRIVATE_KEY=0xYOUR_FUNDED_BASE_MAINNET_KEY \
  -e X402_NETWORK=base \
  -- npx -y @predge/whale-data-mcp
```

**Claude Desktop / Cursor / any MCP client** — add to the client's MCP config:

```json
{
  "mcpServers": {
    "predge-whale-data": {
      "command": "npx",
      "args": ["-y", "@predge/whale-data-mcp"],
      "env": {
        "BUYER_PRIVATE_KEY": "0xYOUR_FUNDED_BASE_MAINNET_KEY",
        "X402_NETWORK": "base"
      }
    }
  }
}
```

That's it — the agent gets **25 tools** (18 paid routes + 7 free tools: discovery,
settlement risk, verdict re-read, verdict report, key status, Desk config, record
verification). Discovery, settlement risk, verdict re-read and record verification need
no key at all. No account; the buyer key pays USDC per call on Base or Solana. Fund it
with a few dollars of USDC (the facilitator pays gas, so no ETH/SOL needed).

### Optional: a Predge key (`PREDGE_KEY`)

Set `PREDGE_KEY` and the server sends it as the `x-predge-key` header on every request:

- **Pilot key**, free, from **https://predge.io/start** (email, no card): the settlement
  estimate (`predge_settlement_estimate`) and delivery verdicts (`predge_verdict`) are
  free for 30 days, and `predge_verdict_report` returns your signed monthly report.
  After the window those calls answer 402 again; with a buyer key they then pay per call.
- **Desk key**, from **https://predge.io/desk** (14-day trial): `predge_desk_config`.

```bash
claude mcp add predge-whale-data -e PREDGE_KEY=pdg_pilot_... -- npx -y @predge/whale-data-mcp
```

The key goes first: a call it covers never pays, even with a buyer key set. Without a key
or a buyer wallet, a paid tool returns the API's 402 explanation (price, networks, how to
pay, where to get a pilot key) instead of failing opaquely. The key is never logged and
never copied into a tool result.

**ElizaOS** — add to your character file (via [`@fleek-platform/eliza-plugin-mcp`](https://github.com/fleek-platform/eliza-plugin-mcp)):

```json
{
  "plugins": ["@fleek-platform/eliza-plugin-mcp"],
  "settings": {
    "mcp": {
      "servers": {
        "predge": {
          "type": "stdio",
          "command": "npx",
          "args": ["-y", "@predge/whale-data-mcp"],
          "env": { "BUYER_PRIVATE_KEY": "0xYOUR_FUNDED_BASE_MAINNET_KEY", "MAX_PRICE_USD": "0.05" }
        }
      }
    }
  }
}
```

Set `MAX_PRICE_USD` to hard-cap spend — any call above it is refused before payment. Full
integration guide (ElizaOS, Claude, raw x402 for non-MCP stacks, spend caps): **https://predge.io/docs#whale-data**

## Tools

| Tool | Price | Returns |
|---|---|---|
| `predge_list_endpoints` | **free** | API description + every endpoint with its price/schema (call first) |
| `predge_settlement_risk` | **free** | Signed live UMA settlement risk for one Polymarket market, read from Polygon: UMA state, current proposal + challenge window, every dispute, UMA-vote status, bulletin-board updates, on-chain resolution, `risk_level` (ok\|watch\|caution\|resolved), `segment_dispute_rate`, `settlement_estimate_available`. The `settlement_estimate` itself is paid: `predge_settlement_estimate`. The tool re-verifies the ed25519 signature and returns `{ verification, record }`. Param: `market` (condition id, numeric market id, or slug). 60 req/min per IP |
| `predge_settlement_estimate` | ~$0.02; **free** with a pilot key | Same signed settlement-risk record **with** `settlement_estimate` (statistic from 2026 Polymarket UMA disputes, not advice). `GET /v1/settlement-risk/:market/estimate`. Check `settlement_estimate_available` in the free record first. Returns `{ verification, record }`. Param: `market` |
| `predge_verdict` ⭐ | $0.05 / $0.50; **free** with a pilot key | **Delivery verdict: was the paid job delivered?** Send `job` (what was promised: `endpoint`, `expected_content_type`, `json_schema`, `required_fields`, `max_latency_ms`, `expected_sha256`…), `delivery` (evidence: `status`, `headers`, `body` or `body_sha256`, timing), `payment` (`amount_usd`, `tx_hash`, `network`, `payer`, `payee`), optional `agent` / `provider_agent` (`id`, `version`, `operator`, `authorization_ref`). `payment.amount_usd` < 1 → `POST /v1/verdicts` ($0.05), ≥ 1 → `POST /v1/verdicts/large` ($0.50; paying it over x402 needs `MAX_PRICE_USD` ≥ 0.5). Returns a signed verdict (`delivered` \| `not_delivered` \| `inconclusive`), per-check results, reason codes and a refund recommendation, as `{ verification, record }` |
| `predge_get_verdict` | **free** | `GET /v1/verdicts/:id`: re-read a stored signed verdict, re-verified. Param: `id` (`vrd_` + 24 chars) |
| `predge_verdict_report` | **free**, needs `PREDGE_KEY` | `GET /v1/verdicts/report`: signed monthly dispute-handling report for the verdicts your key requested (counts, refund recommendations, reason codes, time to verdict, verdict ids). Params: `month` (YYYY-MM), `merchant_id`, `limit`, `cursor`, `sample` |
| `predge_key_status` | **free**, needs `PREDGE_KEY` | `GET /v1/me`: your key's plan, quota and pilot expiry |
| `predge_desk_config` | **free**, needs a Desk key | `GET /v1/desk/config`: watched wallets, alert targets (webhook, Telegram), plan status |
| `predge_verify_record` | **free** | Offline check of any Predge signed record (`predge-attest-v1`): `C(payload) == canonical`, `sha256(canonical) == content_hash`, ed25519 signature, `envelope_signature`, and signer listed active in [`predge-keys.json`](https://api.predge.io/.well-known/predge-keys.json). Param: `record` (JSON string) |
| `predge_whales_latest` | ~$0.005 | Latest whale trades ≥$10k (15-min delay). Param: `limit` (1-100) |
| `predge_whale_market` | ~$0.01 | 7-day whale activity for one market. Param: `condition_id` |
| `predge_signals_daily` | ~$0.02 | 24h digest: top markets, net flow, largest bets |
| `predge_wallets_leaderboard` | ~$0.01 | Wallets ranked by edge over resolved markets. Params: `window` (7d\|30d), `limit` |
| `predge_wallet_profile` | ~$0.01 | Wallet score, win rates, categories, last 20 trades. Param: `address` |
| `predge_markets_movers` | ~$0.005 | Largest YES-price moves. Param: `window` (1h\|6h\|24h) |
| `predge_signals_consensus` | ~$0.03 | Edge-verified smart-money net flow + direction per market |
| `predge_attest` ⭐ | ~$0.02 | **Flagship.** Resolved-outcome attestation — the settled truth for a market (`resolved`, `resolution`, `resolved_at`). Optional `side` (yes\|no) checks whether a past signal/win-rate claim was actually right. Params: `condition_id`, `side` |
| `predge_sports_attest` ⭐ | ~$0.02 | **Flagship.** Ed25519-**signed** settled game outcome (winner, final score, `completed`) from ESPN, verifiable offline against Predge's published key. Optional `winner` (team abbr) → `correct`. Settle bets / prove a track record on tamper-evident truth. Leagues: nba, wnba, nfl, college-football, mlb, nhl, mls, epl, champions-league, laliga. Params: `league`, `event_id`, `winner` |
| `predge_bets_biggest` | ~$0.005 | Top-20 largest single trades across all markets. Param: `window` (24h\|7d) |
| `predge_signals_daily_category` | ~$0.01 | 24h digest scoped to one category. Param: `category` |
| `predge_signals_consensus_category` | ~$0.02 | Consensus scoped to one category. Param: `category` |
| `predge_signals_market` | ~$0.01 | Single-market smart-money verdict ("trust this move?"). Param: `condition_id` |
| `predge_wallet_history` | ~$0.02 | Wallet trade history + running win-rate & PnL curve. Params: `address`, `window` (30d\|90d\|all) |
| `predge_wallets_compare` | ~$0.02 | Compare 2-10 wallets side-by-side + market overlap. Param: `addresses` |
| `predge_market_history` | ~$0.01 | Price/volume history for one market. Params: `condition_id`, `window` (7d\|30d\|all) |

Every paid result includes a note with the on-chain settle tx. Not exposed as tools
(raw x402/HTTP reaches them; see `predge_list_endpoints`): the
`/v1/markets/:id/edge` polling pulse, the `/v1/onchain/*` routes, and the signed-calls /
stakes / track-record routes. Paused routes (503 `signed_wallet_outputs_paused`) have no
tool: the wallet track-record attestation `/v1/wallets/:address/attest` (the
`predge_wallet_attest` tool was removed in 0.3.0), `/v1/onchain/pm-activity`,
`/v1/onchain/pm-flows` and the free `/v1/signal/:address`.

### Verifying signed records yourself

Every Predge signed record carries an `attestation` envelope. The rule is published at
[data.predge.io/canonicalization.md](https://data.predge.io/canonicalization.md):
`canonical` is the payload as JSON with keys sorted at every level and no whitespace;
`content_hash = sha256(canonical)`; `signature` is ed25519 over the UTF-8 bytes of
`canonical`; the signer must be an active key in
`https://api.predge.io/.well-known/predge-keys.json` (attestation kid `13fa3d18a369e6c7`).
`src/verify.ts` implements this with `node:crypto` only.

## Config (env)

Paid tools need a funded key for **at least one rail** — Base (`BUYER_PRIVATE_KEY`)
and/or Solana (`SOLANA_BUYER_SECRET`). Every paid route's 402 offers both networks;
the client pays on whichever it holds a key for (cheapest when both). The
facilitator pays the network fee on either rail — the wallet needs USDC only.

| Var | Default | Notes |
|---|---|---|
| `PREDGE_KEY` | — | Optional. Pilot key ([predge.io/start](https://predge.io/start)) or Desk key ([predge.io/desk](https://predge.io/desk)), sent as `x-predge-key` on every request. Never logged. See above. |
| `BUYER_PRIVATE_KEY` | — | Funded **Base**-mainnet EVM key (`0x…`) for the Base rail. |
| `SOLANA_BUYER_SECRET` | — | Optional. Funded **Solana**-mainnet key (64-number JSON array or base58) for the Solana rail. |
| `X402_NETWORK` | `base` | Base network: `base` = mainnet (real USDC), `base-sepolia` only against a testnet deployment. |
| `X402_SOLANA_NETWORK` | matches `X402_NETWORK` | `solana` (mainnet) or `solana-devnet`. |
| `SOLANA_RPC_URL` | @x402/svm default | Optional custom Solana RPC (public mainnet-beta is rate-limited). |
| `PREDGE_BASE_URL` | `https://api.predge.io` | Override to point at another deployment. `PREDGE_API_URL` is accepted as an alias. Signatures are always checked against the key set on `api.predge.io`. |
| `MAX_PRICE_USD` | `0.05` | Any call priced above this is refused **before** paying. |
| `PREDGE_MCP_USER_AGENT` | `predge-whale-data-mcp/<version>` | Sent on every request (lets the API attribute MCP traffic). |

> `predge_list_endpoints`, `predge_settlement_risk`, `predge_get_verdict` and `predge_verify_record` work without any key.

> **Upgrading from 0.1.10 or older:** those versions default to a decommissioned API
> host and every call fails with 404. Upgrade to 0.2.0 (`npx -y @predge/whale-data-mcp@latest`),
> or set `PREDGE_BASE_URL=https://api.predge.io`.

### Testnet

To exercise the payment path without real money, point `PREDGE_BASE_URL` at a
Base-Sepolia deployment of the API and set `X402_NETWORK=base-sepolia`; fund the
buyer from [faucet.circle.com](https://faucet.circle.com). (The public prod API
is mainnet-only, so testnet needs your own deployment.)

## Safety

- **Price cap** — `MAX_PRICE_USD` is enforced in the payment selector, so an
  over-cap call is refused before any money moves (no wasted request).
- **Network guard** — the client only pays a requirement on the configured
  network; it won't accidentally settle a mainnet requirement while in testnet
  mode (or vice-versa).
- **No key handling beyond env** — the server reads `BUYER_PRIVATE_KEY` from env,
  never logs it, and never sends it anywhere but the local signer. Use a
  dedicated low-balance wallet and keep the key out of version control.
  `PREDGE_KEY` is only ever placed in the `x-predge-key` request header to the
  Predge API; it is never logged, and an API error that echoes it is redacted.

## Run from source

```bash
git clone https://github.com/predgeAI/whale-data-mcp.git
cd whale-data-mcp && npm install && npm run build
# then point your MCP client's "command" at node with args ["/abs/path/whale-data-mcp/dist/index.js"]
```

## Verify locally

```bash
npm test                                               # unit tests (no network, no payment)
npm run inspect                                        # list tools (no payment)
node dist/dev-list-tools.js predge_list_endpoints      # free call against prod
node dist/dev-list-tools.js predge_settlement_risk '{"market":"<condition id or slug>"}'   # free, signed
# paid call (spends real USDC on mainnet):
BUYER_PRIVATE_KEY=0x… X402_NETWORK=base node dist/dev-list-tools.js predge_whales_latest '{"limit":2}'
```
