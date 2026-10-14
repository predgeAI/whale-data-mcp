import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { canonicalJson, extractEnvelope, verifyEnvelope, type PredgeKey } from "../src/verify.js";

// A real GET /v1/settlement-risk/{market} response from api.predge.io (2026-10-14).
const RECORD = JSON.parse(readFileSync(new URL("./fixtures/settlement-risk.json", import.meta.url), "utf8"));

const KEYS: PredgeKey[] = [
  {
    kid: "13fa3d18a369e6c7",
    algorithm: "ed25519",
    public_key: "13fa3d18a369e6c71bf941563ba47822b30182273d5106a0e8fb61c5016352d9",
    active: true,
    role: "attestation",
  },
];

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const check = (r: ReturnType<typeof verifyEnvelope>, name: string) => r.checks.find((c) => c.name === name)?.pass;

test("canonicalJson sorts keys at every level and keeps array order", () => {
  assert.equal(canonicalJson({ b: [3, { z: 1, a: null }], a: "é\n" }), '{"a":"é\\n","b":[3,{"a":null,"z":1}]}');
});

test("live settlement-risk record verifies", () => {
  const r = verifyEnvelope(extractEnvelope(RECORD), KEYS);
  assert.equal(r.valid, true, JSON.stringify(r.checks));
  assert.equal(check(r, "payload_rebuilds_canonical"), true);
  assert.equal(check(r, "content_hash"), true);
  assert.equal(check(r, "signature"), true);
  assert.equal(check(r, "envelope_signature"), true);
  assert.equal(check(r, "key_in_predge_key_set"), true);
});

test("accepts a JSON string and a bare envelope", () => {
  assert.equal(verifyEnvelope(extractEnvelope(JSON.stringify(RECORD)), KEYS).valid, true);
  assert.equal(verifyEnvelope(extractEnvelope(RECORD.attestation), KEYS).valid, true);
});

test("tampered payload fails", () => {
  const rec = clone(RECORD);
  rec.attestation.payload.risk_level = "ok";
  const r = verifyEnvelope(extractEnvelope(rec), KEYS);
  assert.equal(r.valid, false);
  assert.equal(check(r, "payload_rebuilds_canonical"), false);
});

test("tampered canonical fails hash and signature", () => {
  const rec = clone(RECORD);
  rec.attestation.canonical = rec.attestation.canonical.replace('"No"', '"Yes"');
  const r = verifyEnvelope(extractEnvelope(rec), KEYS);
  assert.equal(r.valid, false);
  assert.equal(check(r, "content_hash"), false);
  assert.equal(check(r, "signature"), false);
});

test("swapped envelope annotation fails envelope_signature", () => {
  const rec = clone(RECORD);
  rec.attestation.data_basis = "something else";
  const r = verifyEnvelope(extractEnvelope(rec), KEYS);
  assert.equal(check(r, "signature"), true);
  assert.equal(check(r, "envelope_signature"), false);
  assert.equal(r.valid, false);
});

test("signer not in the key set fails", () => {
  const other = [{ ...KEYS[0], public_key: "a122cc095c0f7fe52645be73dd496498a2d10f7018e85db2f9d721f0a3d997e4" }];
  assert.equal(verifyEnvelope(extractEnvelope(RECORD), other).valid, false);
  assert.equal(verifyEnvelope(extractEnvelope(RECORD), [{ ...KEYS[0], active: false }]).valid, false);
  assert.equal(verifyEnvelope(extractEnvelope(RECORD), null).valid, false);
});

test("non-record input is rejected", () => {
  assert.throws(() => extractEnvelope({ hello: "world" }), /no signed envelope/);
});
