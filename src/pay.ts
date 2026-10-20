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
 * are attributable in the API's discovery-funnel analytics, and PREDGE_KEY
 * (when set) as `x-predge-key`: a pilot key makes the settlement estimate and
 * delivery verdicts free inside its 30-day window, a Desk key opens /v1/desk/*.
 * The key goes first, so a covered call never pays. Without a buyer key a paid
 * route is still requested; its 402 comes back as the API's own explanation.
 */
import { privateKeyToAccount } from "viem/accounts";
import { wrapFetchWithPayment, x402Client, decodePaymentResponseHeader } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { ExactSvmScheme } from "@x402/svm/exact/client";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { config } from "./config.js";

export class PaymentError extends Error {}

/**
 * The API answered 402 and nothing paid: no buyer key, the key did not cover the route,
 * or the key's pilot window ended. `details` is the API's own explanation (price,
 * networks, how to pay, where to get a pilot key) plus what to set in the env.
 */
export class PaymentRequiredError extends PaymentError {
  constructor(
    message: string,
    public readonly details: Record<string, unknown>,
  ) {
    super(message);
  }
}

/** Any other 4xx/5xx from the API. `body` is the parsed JSON error when the API sent one. */
export class UpstreamError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
    text: string,
  ) {
    super(`upstream ${status}${text ? `: ${text.slice(0, 500)}` : ""}`);
  }
}

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

function hasBuyerKey(): boolean {
  return Boolean(config.buyerKey) || Boolean(config.solanaBuyerSecret);
}

/**
 * Headers for every request to the API. PREDGE_KEY, when set, goes in `x-predge-key`.
 * The key is only ever placed in this header: it is never logged and never copied into
 * a tool result or an error message.
 */
export function apiHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const h: Record<string, string> = { "user-agent": config.userAgent, ...extra };
  const key = config.predgeKey;
  if (key) h["x-predge-key"] = key;
  return h;
}

/** Belt and braces: never let the key travel back out in an echoed error body. */
function scrub(text: string): string {
  const key = config.predgeKey;
  return key ? text.split(key).join("<PREDGE_KEY>") : text;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

let cachedFetch: typeof fetch | null = null;

async function payingFetch(): Promise<typeof fetch> {
  if (cachedFetch) return cachedFetch;

  const hasEvm = Boolean(config.buyerKey);
  const hasSvm = Boolean(config.solanaBuyerSecret);
  if (!hasEvm && !hasSvm) throw new PaymentError("no buyer key set (BUYER_PRIVATE_KEY / SOLANA_BUYER_SECRET)");

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

  cachedFetch = wrapFetchWithPayment(globalThis.fetch, client) as typeof fetch;
  return cachedFetch;
}

export interface KeyInfo {
  /** X-Predge-Pilot, e.g. "verdicts_free_until 2026-11-19T…" or "estimate_grant_expired …". */
  pilot: string | null;
  quota_remaining: string | null;
  quota_limit: string | null;
}

export interface PaidResult {
  data: unknown;
  paid: { price_usd: number | null; settle_tx: string | null; network: string | null; payer: string | null } | null;
  /** What the API said about PREDGE_KEY on this call (pilot grant, quota), when it said anything. */
  key: KeyInfo | null;
}

function keyInfo(res: Response): KeyInfo | null {
  const pilot = res.headers.get("x-predge-pilot");
  const remaining = res.headers.get("x-predge-quota-remaining");
  const limit = res.headers.get("x-predge-quota-limit");
  if (pilot === null && remaining === null && limit === null) return null;
  return { pilot, quota_remaining: remaining, quota_limit: limit };
}

function paymentRequired(res: Response, text: string): PaymentRequiredError {
  const body = (parseJson(scrub(text)) ?? {}) as Record<string, unknown>;
  const networks = Array.isArray(body.networks)
    ? (body.networks as Array<Record<string, unknown>>).map((n) => ({ network: n.network, name: n.name, amount: n.amount }))
    : undefined;
  const pilot = res.headers.get("x-predge-pilot");
  const buyer = hasBuyerKey();
  const hints: string[] = [];
  if (!config.predgeKey) {
    hints.push(
      "Set PREDGE_KEY in the MCP server env: a free 30-day pilot key from https://predge.io/start makes the " +
        "settlement estimate and delivery verdicts free inside the pilot window.",
    );
  } else if (pilot) {
    hints.push(`PREDGE_KEY was sent; the API says: ${pilot}.`);
  } else {
    hints.push("PREDGE_KEY was sent but does not cover this route.");
  }
  if (!buyer) {
    hints.push(
      "Or pay per call over x402: set BUYER_PRIVATE_KEY (funded Base-mainnet key) and/or SOLANA_BUYER_SECRET " +
        "(funded Solana-mainnet key); the wallet needs USDC only.",
    );
  }
  const details: Record<string, unknown> = {
    error: "payment_required",
    status: 402,
    price_usd: body.price_usd ?? null,
    message: typeof body.message === "string" ? body.message : "Payment required.",
    resource: body.resource ?? null,
    networks,
    how_to_pay: body.how_to_pay,
    pilot_key: body.pilot_key ?? "https://predge.io/start",
    docs: body.docs ?? "https://predge.io/docs#paying",
    x_predge_pilot: pilot,
    predge_key_sent: Boolean(config.predgeKey),
    buyer_key_configured: buyer,
    what_to_do: hints,
  };
  const price = body.price_usd !== undefined ? `$${String(body.price_usd)}` : "money";
  return new PaymentRequiredError(
    `402 Payment Required: this call costs ${price} and nothing paid for it. ${hints.join(" ")}`,
    details,
  );
}

/**
 * Call a paid route. PREDGE_KEY goes first: a pilot or Desk key that covers the route gets a
 * 2xx without any payment. Otherwise a configured buyer key pays over x402 (price-capped);
 * with no buyer key the request is sent plainly and a 402 comes back as PaymentRequiredError
 * carrying the API's explanation.
 */
export async function payRequest(method: "GET" | "POST", path: string, body?: unknown): Promise<PaidResult> {
  const f = hasBuyerKey() ? await payingFetch() : globalThis.fetch;
  const init: RequestInit = {
    method,
    headers: apiHeaders(body === undefined ? {} : { "content-type": "application/json" }),
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await f(`${config.baseUrl}${path}`, init);
  if (res.status === 402) throw paymentRequired(res, await res.text().catch(() => ""));
  if (res.status >= 400) {
    const text = scrub(await res.text().catch(() => ""));
    throw new UpstreamError(res.status, parseJson(text), text);
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
  return { data, paid, key: keyInfo(res) };
}

/** GET a paid route, paying under the hood. Returns parsed JSON + settle info. */
export async function payGet(path: string): Promise<PaidResult> {
  return payRequest("GET", path);
}

/** POST JSON to a paid route, paying under the hood. */
export async function payPost(path: string, body: unknown): Promise<PaidResult> {
  return payRequest("POST", path, body);
}

/** GET a FREE route (no payment): discovery, settlement risk, verdict re-read, key routes. */
export async function freeGet(path: string): Promise<unknown> {
  const res = await globalThis.fetch(`${config.baseUrl}${path}`, {
    method: "GET",
    headers: apiHeaders(),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const text = scrub(await res.text().catch(() => ""));
    throw new UpstreamError(res.status, parseJson(text), text);
  }
  return res.json();
}
