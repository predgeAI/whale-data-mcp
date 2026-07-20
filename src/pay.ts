/**
 * x402-paying HTTP layer for the MCP tools. One shared client signs EIP-3009
 * payments with the operator's BUYER_PRIVATE_KEY; the facilitator settles
 * on-chain (no ETH needed). Two guards live in the payment selector so they
 * fire BEFORE any money moves and cost no extra request:
 *   - price cap  (MAX_PRICE_USD) — refuse calls priced above the cap
 *   - network    — only pay on the configured network (won't accidentally
 *                  pay a mainnet requirement while in testnet mode)
 *
 * Every request carries a recognizable User-Agent so MCP-originated calls
 * are attributable in the API's discovery-funnel analytics.
 */
import { privateKeyToAccount } from "viem/accounts";
import { wrapFetchWithPayment, x402Client, decodePaymentResponseHeader } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { config } from "./config.js";

export class PaymentError extends Error {}

interface Requirement {
  scheme?: string;
  network?: string;
  amount?: string;
  maxAmountRequired?: string;
  asset?: string;
}

function amountUsd(r: Requirement): number | null {
  const a = r.amount ?? r.maxAmountRequired;
  if (!a) return null;
  try {
    return Number(BigInt(a)) / 1e6; // USDC 6-decimals
  } catch {
    return null;
  }
}

let cachedFetch: typeof fetch | null = null;

function payingFetch(): typeof fetch {
  if (cachedFetch) return cachedFetch;
  if (!config.buyerKey) {
    const funding = config.network === "eip155:8453"
      ? "a funded Base MAINNET buyer wallet (real USDC; the facilitator pays gas, no ETH needed)"
      : "a funded Base Sepolia buyer wallet (testnet USDC from https://faucet.circle.com)";
    throw new PaymentError(
      `BUYER_PRIVATE_KEY is not set. Paid tools need ${funding}. Set it in the MCP server env. ` +
        "The free tool predge_list_endpoints works without a key.",
    );
  }
  const signer = privateKeyToAccount(config.buyerKey);

  const client = new x402Client((_v: number, reqs: Requirement[]) => {
    const onNet = reqs.filter((r) => (r.scheme ?? "exact") === "exact" && r.network === config.network);
    if (onNet.length === 0) {
      throw new PaymentError(
        `no payment option on ${config.network}; server offered ${reqs.map((r) => r.network).join(", ") || "none"}`,
      );
    }
    // Cheapest matching requirement.
    const chosen = onNet.reduce((a, b) => ((amountUsd(a) ?? Infinity) <= (amountUsd(b) ?? Infinity) ? a : b));
    const price = amountUsd(chosen);
    if (price !== null && price > config.maxPriceUsd) {
      throw new PaymentError(
        `price $${price.toFixed(3)} exceeds MAX_PRICE_USD $${config.maxPriceUsd.toFixed(3)} — refusing to pay`,
      );
    }
    return chosen as never;
  });
  client.register("eip155:*", new ExactEvmScheme(signer));

  cachedFetch = wrapFetchWithPayment(fetch, client) as typeof fetch;
  return cachedFetch;
}

export interface PaidResult {
  data: unknown;
  paid: { price_usd: number | null; settle_tx: string | null; network: string | null; payer: string | null } | null;
}

/** GET a paid route, paying under the hood. Returns parsed JSON + settle info. */
export async function payGet(path: string): Promise<PaidResult> {
  const f = payingFetch();
  const res = await f(`${config.baseUrl}${path}`, {
    method: "GET",
    headers: { "user-agent": config.userAgent },
  });
  if (res.status >= 400) {
    const body = await res.text().catch(() => "");
    throw new PaymentError(`upstream ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();

  let paid: PaidResult["paid"] = null;
  const hdr = res.headers.get("payment-response") ?? res.headers.get("x-payment-response");
  if (hdr) {
    try {
      const settle = decodePaymentResponseHeader(hdr) as {
        success?: boolean; transaction?: string; network?: string; payer?: string;
      };
      paid = {
        price_usd: null,
        settle_tx: settle.transaction ?? null,
        network: settle.network ?? null,
        payer: settle.payer ?? null,
      };
    } catch {
      /* leave paid null */
    }
  }
  return { data, paid };
}

/** GET a FREE route (no payment) — used by the discovery tool. */
export async function freeGet(path: string): Promise<unknown> {
  const res = await fetch(`${config.baseUrl}${path}`, {
    method: "GET",
    headers: { "user-agent": config.userAgent },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`upstream ${res.status}`);
  return res.json();
}
