import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

delete process.env.PREDGE_BASE_URL;
delete process.env.PREDGE_API_URL;
const { config, VERSION } = await import("../src/config.js");
const { buildServer } = await import("../src/server.js");

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

test("default API host is api.predge.io", () => {
  assert.equal(config.baseUrl, "https://api.predge.io");
});

test("no decommissioned host anywhere in src or shipped metadata", () => {
  const files = [
    ...readdirSync(new URL("../src", import.meta.url)).map((f) => `src/${f}`),
    "README.md",
    ".env.example",
    "server.json",
    "manifest.json",
    "smithery.yaml",
  ];
  for (const f of files) assert.doesNotMatch(read(f), /up\.railway\.app/, f);
});

test("versions agree: package.json, server.json, manifest.json, VERSION", () => {
  const pkg = JSON.parse(read("package.json")).version;
  const srv = JSON.parse(read("server.json"));
  const man = JSON.parse(read("manifest.json")).version;
  assert.equal(VERSION, pkg);
  assert.equal(srv.version, pkg);
  assert.equal(srv.packages[0].version, pkg);
  assert.equal(man, pkg);
});

test("tool list matches the live API surface", async () => {
  const server = buildServer();
  const [c, s] = InMemoryTransport.createLinkedPair();
  await server.connect(s);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(c);
  const { tools } = await client.listTools();
  await client.close();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "predge_attest",
    "predge_bets_biggest",
    "predge_desk_config",
    "predge_get_verdict",
    "predge_key_status",
    "predge_list_endpoints",
    "predge_market_history",
    "predge_markets_movers",
    "predge_settlement_estimate",
    "predge_settlement_risk",
    "predge_signals_consensus",
    "predge_signals_consensus_category",
    "predge_signals_daily",
    "predge_signals_daily_category",
    "predge_signals_market",
    "predge_sports_attest",
    "predge_verdict",
    "predge_verdict_report",
    "predge_verify_record",
    "predge_wallet_history",
    "predge_wallet_profile",
    "predge_wallets_compare",
    "predge_wallets_leaderboard",
    "predge_whale_market",
    "predge_whales_latest",
  ]);
});

test("no tool, description or metadata advertises a paused route", async () => {
  const server = buildServer();
  const [c, s] = InMemoryTransport.createLinkedPair();
  await server.connect(s);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(c);
  const { tools } = await client.listTools();
  await client.close();
  const paused = /wallet_attest|\/attest\b.*wallet|wallets\/[^ ]*\/attest|pm-activity|pm-flows|\/v1\/signal\//;
  for (const t of tools) assert.doesNotMatch(`${t.name} ${t.description ?? ""}`, paused, t.name);
  for (const f of ["manifest.json", "server.json", "smithery.yaml"]) assert.doesNotMatch(read(f), paused, f);
});

test("PREDGE_KEY is declared as a secret in server.json, manifest.json and smithery.yaml", () => {
  const env = JSON.parse(read("server.json")).packages[0].environmentVariables as Array<{ name: string; isSecret?: boolean }>;
  assert.equal(env.find((e) => e.name === "PREDGE_KEY")?.isSecret, true);
  const man = JSON.parse(read("manifest.json"));
  assert.equal(man.server.mcp_config.env.PREDGE_KEY, "${user_config.predge_key}");
  assert.equal(man.user_config.predge_key.sensitive, true);
  assert.match(read("smithery.yaml"), /PREDGE_KEY/);
});
