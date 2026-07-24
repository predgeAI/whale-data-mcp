/**
 * x402-paying HTTP layer for the MCP tools. One shared client signs payments
 * with the operator's key(s); the facilitator settles on-chain (no gas token
 * needed on either rail). Two rails, both opt-in via env:
 *   - Base   — BUYER_PRIVATE_KEY (EVM, EIP-3009)
 *   - Solana — SOLANA_BUYER_SECRET (ed25519, SPL-USDC transfer)
 * Every paid route's 402 offers both; the selector pays on whichever network a
 * key is registered for (cheapest when both). Two guards fire in the selector
 * BEFORE any money moves and cost no extra request:
 *   - price cap  (MAX_PRICE_USD) — refuse calls priced above the cap
 *   - network    — only pay a network we hold a key for (won't accidentally pay
 *                  a mainnet requirement while in testnet mode)
 *
 * Every request carries a recognizable User-Agent so MCP-originated calls
 * are attributable in the API's discovery-funnel analytics.
 */
import { privateKeyToAccount } from "viem/accounts";
import { wrapFetchWithPayment, x402Client, decodePaymentResponseHeader } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { ExactSvmScheme } from "@x402/svm/exact/client";
import { createKeyPairSignerFromBytes } from "@solana/kit";
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

async function payingFetch(): Promise<typeof fetch> {
  if (cachedFetch) return cachedFetch;

  const hasEvm = Boolean(config.buyerKey);
  const hasSvm = Boolean(config.solanaBuyerSecret);
  if (!hasEvm && !hasSvm) {
    throw new PaymentError(
      "No buyer key set. Paid tools need a funded key for at least one rail: " +
        "BUYER_PRIVATE_KEY (a Base-mainnet EVM key) and/or SOLANA_BUYER_SECRET (a Solana-mainnet key; " +
        "64-number JSON array or base58). The facilitator pays the network fee on either rail — the " +
        "wallet needs USDC only. Set one in the MCP server env. The free tool predge_list_endpoints " +
        "works without a key.",
    );
  }

  // Networks we can actually pay on — one per registered scheme.
  const payable = new Set<string>();
  if (hasEvm) payable.add(config.network); // eip155:… (config.network)
  if (hasSvm) payable.add(config.solanaNetwork); // solana:…

  const client = new x402Client((_v: number, reqs: Requirement[]) => {
    const options = reqs.filter(
      (r) => (r.scheme ?? "exact") === "exact" && !!r.network && payable.has(r.network),
    );
    if (options.length === 0) {
      throw new PaymentError(
        `no payable option: server offered [${reqs.map((r) => r.network).join(", ") || "none"}], ` +
          `we hold a key for [${[...payable].join(", ") || "none"}] — set BUYER_PRIVATE_KEY / ` +
          "SOLANA_BUYER_SECRET for the network you want to pay on",
      );
    }
    // Cheapest payable requirement (Base and Solana are the same price today).
    const chosen = options.reduce((a, b) => ((amountUsd(a) ?? Infinity) <= (amountUsd(b) ?? Infinity) ? a : b));
    const price = amountUsd(chosen);
    if (price !== null && price > config.maxPriceUsd) {
      throw new PaymentError(
        `price $${price.toFixed(3)} exceeds MAX_PRICE_USD $${config.maxPriceUsd.toFixed(3)} — refusing to pay`,
      );
    }
    return chosen as never;
  });

  if (hasEvm) client.register("eip155:*", new ExactEvmScheme(privateKeyToAccount(config.buyerKey!)));
  if (hasSvm) {
    const solanaSigner = await createKeyPairSignerFromBytes(config.solanaBuyerSecret!);
    client.register(
      "solana:*",
      new ExactSvmScheme(solanaSigner, config.solanaRpcUrl ? { rpcUrl: config.solanaRpcUrl } : undefined),
    );
  }

  cachedFetch = wrapFetchWithPayment(fetch, client) as typeof fetch;
  return cachedFetch;
}

export interface PaidResult {
  data: unknown;
  paid: { price_usd: number | null; settle_tx: string | null; network: string | null; payer: string | null } | null;
}

/** GET a paid route, paying under the hood. Returns parsed JSON + settle info. */
export async function payGet(path: string): Promise<PaidResult> {
  const f = await payingFetch();
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
