# @predge/whale-data-mcp

MCP server that exposes the **Predge Whale Data** x402 API (Polymarket whale
trades + smart-money signals) as tools. Payment is handled **under the hood**:
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

That's it — the agent gets **16 tools** (15 paid routes + 1 free discovery tool).
No API keys, no account; the buyer key pays USDC per call on Base. Fund it with a
few dollars of USDC (the facilitator pays gas, so no ETH needed).

## Tools

| Tool | Price | Returns |
|---|---|---|
| `predge_list_endpoints` | **free** | API description + every endpoint with its price/schema (call first) |
| `predge_whales_latest` | ~$0.005 | Latest whale trades ≥$10k (15-min delay). Param: `limit` (1-100) |
| `predge_whale_market` | ~$0.01 | 7-day whale activity for one market. Param: `condition_id` |
| `predge_signals_daily` | ~$0.02 | 24h digest: top markets, net flow, largest bets |
| `predge_wallets_leaderboard` | ~$0.01 | Wallets by realized win rate. Params: `window` (7d\|30d), `limit` |
| `predge_wallet_profile` | ~$0.01 | Wallet score, win rates, categories, last 20 trades. Param: `address` |
| `predge_markets_movers` | ~$0.005 | Largest YES-price moves. Param: `window` (1h\|6h\|24h) |
| `predge_signals_consensus` | ~$0.03 | Edge-verified smart-money net flow + direction per market |
| `predge_attest` ⭐ | ~$0.02 | **Flagship.** Resolved-outcome attestation — the settled truth for a market (`resolved`, `resolution`, `resolved_at`). Optional `side` (yes\|no) checks whether a past signal/win-rate claim was actually right. Params: `condition_id`, `side` |
| `predge_bets_biggest` | ~$0.005 | Top-20 largest single trades across all markets. Param: `window` (24h\|7d) |
| `predge_signals_daily_category` | ~$0.01 | 24h digest scoped to one category. Param: `category` |
| `predge_signals_consensus_category` | ~$0.02 | Consensus scoped to one category. Param: `category` |
| `predge_signals_market` | ~$0.01 | Single-market smart-money verdict ("trust this move?"). Param: `condition_id` |
| `predge_wallet_history` | ~$0.02 | Wallet trade history + running win-rate & PnL curve. Params: `address`, `window` (30d\|90d\|all) |
| `predge_wallets_compare` | ~$0.02 | Compare 2-10 wallets side-by-side + market overlap. Param: `addresses` |
| `predge_market_history` | ~$0.01 | Price/volume history for one market. Params: `condition_id`, `window` (7d\|30d\|all) |

Every paid result includes a note with the on-chain settle tx. The two Kalshi routes
(anonymous institutional flow) are not yet exposed as tools — they activate when Kalshi
ingest is enabled; raw x402/HTTP already reaches them.

## Config (env)

| Var | Default | Notes |
|---|---|---|
| `BUYER_PRIVATE_KEY` | — | **Required for paid tools.** Funded buyer key. The free `predge_list_endpoints` tool works without it. |
| `X402_NETWORK` | `base` | `base` = mainnet (real USDC). `base-sepolia` only works against a testnet deployment (see `PREDGE_BASE_URL`). |
| `PREDGE_BASE_URL` | prod API | `https://x402-api-production-266e.up.railway.app`. Override to point at another deployment (e.g. a testnet instance). |
| `MAX_PRICE_USD` | `0.05` | Any call priced above this is refused **before** paying. |
| `PREDGE_MCP_USER_AGENT` | `predge-whale-data-mcp/0.1.1` | Sent on every request (lets the API attribute MCP traffic). |

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

## Run from source

```bash
git clone https://github.com/predgeAI/whale-data-mcp.git
cd whale-data-mcp && npm install && npm run build
# then point your MCP client's "command" at node with args ["/abs/path/whale-data-mcp/dist/index.js"]
```

## Verify locally

```bash
npm run inspect                                        # list tools (no payment)
node dist/dev-list-tools.js predge_list_endpoints      # free call against prod
# paid call (spends real USDC on mainnet):
BUYER_PRIVATE_KEY=0x… X402_NETWORK=base node dist/dev-list-tools.js predge_whales_latest '{"limit":2}'
```
