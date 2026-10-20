/**
 * Tool behaviour against a mocked API (globalThis.fetch is replaced; no network, no payment).
 * No buyer key is set, so paid routes go out as plain requests: the pilot key path and the
 * 402 explanation are what is under test here.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

delete process.env.PREDGE_BASE_URL;
delete process.env.PREDGE_API_URL;
delete process.env.BUYER_PRIVATE_KEY;
delete process.env.SOLANA_BUYER_SECRET;
delete process.env.PREDGE_KEY;
const { buildServer } = await import("../src/server.js");

const KEY = "pdg_pilot_" + "A".repeat(43);
// A real signed record (settlement risk); any predge-attest-v1 record exercises the verifier wiring.
const SIGNED = JSON.parse(readFileSync(new URL("./fixtures/settlement-risk.json", import.meta.url), "utf8"));
const KEYSET = {
  keys: [
    {
      kid: "13fa3d18a369e6c7",
      algorithm: "ed25519",
      public_key: "13fa3d18a369e6c71bf941563ba47822b30182273d5106a0e8fb61c5016352d9",
      active: true,
      role: "attestation",
    },
  ],
};
const PAYMENT_REQUIRED = {
  x402Version: 1,
  accepts: [],
  error: "Payment required",
  message: "Payment required: 0.05 USDC per call. This is the x402 protocol: …",
  price_usd: "0.05",
  resource: "https://api.predge.io/v1/verdicts",
  networks: [{ network: "eip155:8453", name: "Base", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", pay_to: "0x9084", amount: "50000" }],
  how_to_pay: { client: "https://predge.io/docs#paying" },
  docs: "https://predge.io/docs",
  pilot_key: "https://predge.io/start",
};

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}
let calls: Call[] = [];
type Reply = { status: number; body: unknown; headers?: Record<string, string> };
let route: (c: Call) => Reply = () => ({ status: 500, body: { error: "unrouted" } });

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
  const call: Call = {
    url,
    method: init?.method ?? "GET",
    headers,
    body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
  };
  if (url.endsWith("/.well-known/predge-keys.json")) {
    calls.push(call);
    return new Response(JSON.stringify(KEYSET), { status: 200, headers: { "content-type": "application/json" } });
  }
  calls.push(call);
  const r = route(call);
  return new Response(JSON.stringify(r.body), {
    status: r.status,
    headers: { "content-type": "application/json", ...(r.headers ?? {}) },
  });
}) as typeof fetch;

async function connect() {
  const server = buildServer();
  const [c, s] = InMemoryTransport.createLinkedPair();
  await server.connect(s);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(c);
  return client;
}

type Result = {
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
};
async function call(name: string, args: Record<string, unknown> = {}): Promise<Result> {
  const client = await connect();
  try {
    return (await client.callTool({ name, arguments: args })) as Result;
  } finally {
    await client.close();
  }
}
const text = (r: Result) => r.content.map((c) => c.text ?? "").join("\n");
const apiCalls = () => calls.filter((c) => !c.url.endsWith("/.well-known/predge-keys.json"));

const VERDICT_ARGS = {
  job: { endpoint: "https://merchant.example/v1/report", expected_content_type: "application/json", required_fields: ["data.id"] },
  delivery: { status: 200, headers: { "content-type": "application/json" }, body: '{"data":{"id":1}}', latency_ms: 420 },
  payment: { amount_usd: 0.25, tx_hash: "0xabc", network: "eip155:8453", payer: "0x1", payee: "0x2" },
  merchant_id: "merchant-1",
  agent: { id: "eip155:8453:0x8004:123", version: "1.2.0", operator: "Acme Agents", authorization_ref: "mandate-7" },
  provider_agent: { id: "merchant-bot", version: "3", operator: "Merchant Inc" },
};

beforeEach(() => {
  calls = [];
  delete process.env.PREDGE_KEY;
  route = () => ({ status: 500, body: { error: "unrouted" } });
});

test("PREDGE_KEY is sent as x-predge-key on paid, free and key-set requests", async () => {
  process.env.PREDGE_KEY = KEY;
  route = (c) => (c.url.includes("/estimate") ? { status: 200, body: SIGNED, headers: { "x-predge-pilot": "estimate_free_until 2026-11-19T00:00:00.000Z" } } : { status: 200, body: SIGNED });
  const est = await call("predge_settlement_estimate", { market: "5608010" });
  assert.equal(est.isError, undefined, text(est));
  await call("predge_settlement_risk", { market: "5608010" });
  assert.ok(calls.length >= 3);
  for (const c of calls) assert.equal(c.headers["x-predge-key"], KEY, c.url);
  const sc = est.structuredContent as { data: { verification: { valid: boolean } }; predge_key: { pilot: string } };
  assert.equal(sc.data.verification.valid, true);
  assert.match(sc.predge_key.pilot, /estimate_free_until/);
  assert.ok(!text(est).includes(KEY), "key must not appear in tool output");
});

test("without PREDGE_KEY no x-predge-key header is sent", async () => {
  route = () => ({ status: 200, body: SIGNED });
  await call("predge_settlement_risk", { market: "5608010" });
  for (const c of calls) assert.equal(c.headers["x-predge-key"], undefined);
});

test("predge_verdict routes by payment.amount_usd and posts the full request", async () => {
  process.env.PREDGE_KEY = KEY;
  route = () => ({ status: 200, body: SIGNED, headers: { "x-predge-pilot": "verdicts_free_until 2026-11-19T00:00:00.000Z" } });

  const small = await call("predge_verdict", VERDICT_ARGS);
  assert.equal(small.isError, undefined, text(small));
  let post = apiCalls()[0];
  assert.equal(post.method, "POST");
  assert.equal(post.url, "https://api.predge.io/v1/verdicts");
  assert.equal(post.headers["content-type"], "application/json");
  assert.equal(post.headers["x-predge-key"], KEY);
  assert.deepEqual(post.body, VERDICT_ARGS);
  assert.equal((small.structuredContent as { data: { verification: { valid: boolean } } }).data.verification.valid, true);
  assert.match(text(small), /verdicts_free_until/);

  calls = [];
  await call("predge_verdict", { ...VERDICT_ARGS, payment: { amount_usd: 1 } });
  post = apiCalls()[0];
  assert.equal(post.url, "https://api.predge.io/v1/verdicts/large");
});

test("predge_verdict rejects an agent identity with unknown fields", async () => {
  const r = await call("predge_verdict", { ...VERDICT_ARGS, agent: { ...VERDICT_ARGS.agent, extra: "x" } });
  assert.equal(r.isError, true);
  assert.equal(apiCalls().length, 0);
});

test("402 without a key or wallet returns the API's explanation, not an opaque failure", async () => {
  route = () => ({ status: 402, body: PAYMENT_REQUIRED });
  const r = await call("predge_verdict", VERDICT_ARGS);
  assert.equal(r.isError, true);
  const t = text(r);
  assert.match(t, /402 Payment Required/);
  assert.match(t, /\$0\.05/);
  assert.match(t, /predge\.io\/start/);
  assert.match(t, /BUYER_PRIVATE_KEY/);
  const err = (r.structuredContent as { error: Record<string, unknown> }).error;
  assert.equal(err.error, "payment_required");
  assert.equal(err.price_usd, "0.05");
  assert.equal(err.predge_key_sent, false);
  assert.equal(err.buyer_key_configured, false);
  assert.deepEqual(err.networks, [{ network: "eip155:8453", name: "Base", amount: "50000" }]);
});

test("402 with an expired pilot key says so", async () => {
  process.env.PREDGE_KEY = KEY;
  route = () => ({ status: 402, body: PAYMENT_REQUIRED, headers: { "x-predge-pilot": "estimate_grant_expired 2026-10-01T00:00:00.000Z" } });
  const r = await call("predge_settlement_estimate", { market: "5608010" });
  assert.equal(r.isError, true);
  assert.match(text(r), /estimate_grant_expired/);
  assert.equal((r.structuredContent as { error: Record<string, unknown> }).error.predge_key_sent, true);
  assert.ok(!text(r).includes(KEY));
});

test("paid tools without any key still reach the API and explain the 402", async () => {
  route = () => ({ status: 402, body: { ...PAYMENT_REQUIRED, price_usd: "0.005" } });
  const r = await call("predge_whales_latest", { limit: 2 });
  assert.equal(r.isError, true);
  assert.equal(apiCalls()[0].url, "https://api.predge.io/v1/whales/latest?limit=2");
  assert.match(text(r), /\$0\.005/);
});

test("predge_get_verdict reads by id for free and verifies", async () => {
  route = () => ({ status: 200, body: SIGNED });
  const id = "vrd_" + "abcDEF012345_-abcDEF0123";
  const r = await call("predge_get_verdict", { id });
  assert.equal(r.isError, undefined, text(r));
  assert.equal(apiCalls()[0].url, `https://api.predge.io/v1/verdicts/${id}`);
  assert.equal(apiCalls()[0].method, "GET");
  assert.equal((r.structuredContent as { data: { verification: { valid: boolean } } }).data.verification.valid, true);

  calls = [];
  const bad = await call("predge_get_verdict", { id: "vrd_short" });
  assert.equal(bad.isError, true);
  assert.equal(apiCalls().length, 0);
});

test("predge_get_verdict surfaces 404 verdict_not_found", async () => {
  route = () => ({ status: 404, body: { error: "verdict_not_found" } });
  const r = await call("predge_get_verdict", { id: "vrd_" + "a".repeat(24) });
  assert.equal(r.isError, true);
  assert.match(text(r), /verdict_not_found/);
  assert.deepEqual((r.structuredContent as { error: unknown }).error, { status: 404, body: { error: "verdict_not_found" } });
});

test("predge_verdict_report needs PREDGE_KEY and sends no request without it", async () => {
  const r = await call("predge_verdict_report", { month: "2026-10" });
  assert.equal(r.isError, true);
  assert.match(text(r), /PREDGE_KEY/);
  assert.match(text(r), /predge\.io\/start/);
  assert.equal(calls.length, 0);
});

test("predge_verdict_report with a key passes month and paging params", async () => {
  process.env.PREDGE_KEY = KEY;
  route = () => ({ status: 200, body: SIGNED });
  const r = await call("predge_verdict_report", { month: "2026-10", merchant_id: "m-1", limit: 50, cursor: "c1", sample: 0 });
  assert.equal(r.isError, undefined, text(r));
  const u = new URL(apiCalls()[0].url);
  assert.equal(u.pathname, "/v1/verdicts/report");
  assert.equal(u.searchParams.get("month"), "2026-10");
  assert.equal(u.searchParams.get("merchant_id"), "m-1");
  assert.equal(u.searchParams.get("limit"), "50");
  assert.equal(u.searchParams.get("cursor"), "c1");
  assert.equal(u.searchParams.get("sample"), "0");
  assert.equal(apiCalls()[0].headers["x-predge-key"], KEY);
});

test("predge_verdict_report rejects a malformed month before any request", async () => {
  process.env.PREDGE_KEY = KEY;
  const r = await call("predge_verdict_report", { month: "2026-13" });
  assert.equal(r.isError, true);
  assert.equal(calls.length, 0);
});

test("predge_desk_config and predge_key_status use the key; without it they answer locally", async () => {
  let r = await call("predge_desk_config");
  assert.equal(r.isError, true);
  assert.equal(calls.length, 0);

  process.env.PREDGE_KEY = KEY;
  route = (c) => ({ status: 200, body: c.url.endsWith("/v1/me") ? { plan: "pilot" } : { wallets: ["0xabc"] } });
  r = await call("predge_desk_config");
  assert.equal(r.isError, undefined, text(r));
  assert.equal(apiCalls()[0].url, "https://api.predge.io/v1/desk/config");
  assert.equal(apiCalls()[0].headers["x-predge-key"], KEY);
  r = await call("predge_key_status");
  assert.equal(apiCalls()[1].url, "https://api.predge.io/v1/me");
  assert.match(text(r), /pilot/);
});

test("an upstream error that echoes the key never shows it", async () => {
  process.env.PREDGE_KEY = KEY;
  route = () => ({ status: 401, body: { error: "invalid_key", message: `bad key ${KEY}` } });
  const r = await call("predge_desk_config");
  assert.equal(r.isError, true);
  assert.match(text(r), /invalid_key/);
  assert.ok(!JSON.stringify(r).includes(KEY));
});
