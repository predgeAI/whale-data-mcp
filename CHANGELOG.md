# Changelog

## 0.2.1 — 2026-10-16

### Changed
- `settlement_estimate` moved out of the free settlement-risk record (API change
  16.10). The free record now carries `settlement_estimate_available`;
  `predge_settlement_risk` description and README updated.

### Added
- `predge_settlement_estimate` (paid, ~$0.02): `GET /v1/settlement-risk/:market/estimate`,
  the signed record with `settlement_estimate`. The tool verifies the record and
  returns `{ verification, record }`.

## 0.2.0 — 2026-10-14

### Fixed
- Default API host is `https://api.predge.io`. 0.1.10 and older defaulted to a
  decommissioned host and every call returned 404. `.env.example` still named
  the old host; it now names `api.predge.io`.

### Added
- `predge_settlement_risk` (free): `GET /v1/settlement-risk/:market`, signed live
  UMA settlement risk for one Polymarket market. The tool verifies the record and
  returns `{ verification, record }`.
- `predge_verify_record` (free): offline check of any Predge `predge-attest-v1`
  record (payload re-canonicalisation, `content_hash`, ed25519 signature,
  `envelope_signature`, signer in `/.well-known/predge-keys.json`).
- `src/verify.ts`: dependency-free verifier (`node:crypto`).
- `PREDGE_API_URL` accepted as an alias of `PREDGE_BASE_URL`.
- `npm test` (node:test via tsx): verifier against a real production record,
  tamper cases, version sync across package.json / server.json / manifest.json,
  default host, and the tool list.

### Changed
- All 18 paid tools checked against the live route list (`/`, `/openapi.json`):
  every route exists and answers 402. No tool called `/v1/signal` (paused, 503).
- Free-route errors now include the API's error body (e.g. `unknown_market`).
- The server reports the package version; the default User-Agent is
  `predge-whale-data-mcp/<version>`.
- Leaderboard description: ranked by edge, not raw win rate.
- `prepublishOnly` runs typecheck and tests before the build.

## 0.1.11
- Default API host switched to `https://api.predge.io`.

## 0.1.10 and older
- Defaulted to the old Railway host, now decommissioned (404).
