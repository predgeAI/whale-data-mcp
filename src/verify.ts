/**
 * Offline checker for Predge signed records (`predge-attest-v1` envelopes).
 * Rule: https://data.predge.io/canonicalization.md
 *
 *   1. C(payload) === canonical           (the object you read is what was signed)
 *   2. sha256(canonical) === content_hash (when the envelope carries one)
 *   3. ed25519(signature, canonical, public_key)
 *   4. envelope_signature over C(envelope minus envelope_signature) (when present)
 *   5. public_key is listed with active:true in the Predge key set
 *
 * Uses node:crypto only (no extra dependencies). The key set is passed in, so
 * the checks themselves need no network.
 */
import { createHash, createPublicKey, verify as edVerify } from "node:crypto";

export const KEYS_PATH = "/.well-known/predge-keys.json";

export interface PredgeKey {
  kid?: string;
  algorithm?: string;
  public_key: string;
  active?: boolean;
  role?: string;
}

export interface Envelope {
  payload?: unknown;
  canonical?: string;
  signature?: string;
  public_key?: string;
  content_hash?: string;
  envelope_signature?: string;
  kid?: string;
  [k: string]: unknown;
}

export interface Check {
  name: string;
  pass: boolean | null; // null = not applicable (field absent)
  detail?: string;
}

export interface VerifyResult {
  valid: boolean;
  checks: Check[];
  kid: string | null;
  content_hash: string | null;
}

/** Predge canonical JSON: keys sorted at every level, no whitespace, JSON.stringify strings. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(",")}}`;
}

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const HEX64 = /^[0-9a-f]{64}$/i;
const HEX128 = /^[0-9a-f]{128}$/i;

export function ed25519Verify(publicKeyHex: string, message: string, signatureHex: string): boolean {
  if (!HEX64.test(publicKeyHex) || !HEX128.test(signatureHex)) return false;
  try {
    const key = createPublicKey({
      format: "der",
      type: "spki",
      key: Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(publicKeyHex, "hex")]),
    });
    return edVerify(null, Buffer.from(message, "utf8"), key, Buffer.from(signatureHex, "hex"));
  } catch {
    return false;
  }
}

/** Accepts a full API response ({attestation: {...}}), a bare envelope, or a JSON string of either. */
export function extractEnvelope(record: unknown): Envelope {
  const r = typeof record === "string" ? (JSON.parse(record) as unknown) : record;
  if (!r || typeof r !== "object") throw new Error("record must be a JSON object");
  const o = r as Record<string, unknown>;
  const env = (o.attestation && typeof o.attestation === "object" ? o.attestation : o) as Envelope;
  if (typeof env.canonical !== "string" || typeof env.signature !== "string" || typeof env.public_key !== "string") {
    throw new Error("no signed envelope found (need canonical, signature, public_key — usually under `attestation`)");
  }
  return env;
}

export function verifyEnvelope(envelope: Envelope, keys: PredgeKey[] | null): VerifyResult {
  const checks: Check[] = [];
  const canonical = envelope.canonical as string;
  const pub = (envelope.public_key as string).toLowerCase();
  const hash = sha256Hex(canonical);

  if (envelope.payload !== undefined) {
    const rebuilt = canonicalJson(envelope.payload) === canonical;
    checks.push({ name: "payload_rebuilds_canonical", pass: rebuilt, detail: rebuilt ? undefined : "C(payload) != canonical" });
  } else {
    checks.push({ name: "payload_rebuilds_canonical", pass: null, detail: "no payload field; trust canonical only" });
  }

  if (typeof envelope.content_hash === "string") {
    const ok = envelope.content_hash.toLowerCase() === hash;
    checks.push({ name: "content_hash", pass: ok, detail: ok ? undefined : `sha256(canonical)=${hash}` });
  } else {
    checks.push({ name: "content_hash", pass: null, detail: `not in envelope; sha256(canonical)=${hash}` });
  }

  checks.push({ name: "signature", pass: ed25519Verify(pub, canonical, envelope.signature as string) });

  if (typeof envelope.envelope_signature === "string") {
    const { envelope_signature, ...rest } = envelope;
    checks.push({ name: "envelope_signature", pass: ed25519Verify(pub, canonicalJson(rest), envelope_signature) });
  } else {
    checks.push({ name: "envelope_signature", pass: null, detail: "route does not sign the envelope" });
  }

  if (keys) {
    const listed = keys.find((k) => k.public_key?.toLowerCase() === pub);
    const ok = Boolean(listed && listed.active === true);
    checks.push({
      name: "key_in_predge_key_set",
      pass: ok,
      detail: listed ? (ok ? `kid ${listed.kid ?? pub.slice(0, 16)}` : "key listed but not active") : "public_key is NOT a Predge key",
    });
  } else {
    checks.push({ name: "key_in_predge_key_set", pass: false, detail: "key set unavailable; signer not confirmed" });
  }

  return {
    valid: checks.every((c) => c.pass !== false),
    checks,
    kid: pub.slice(0, 16),
    content_hash: hash,
  };
}
