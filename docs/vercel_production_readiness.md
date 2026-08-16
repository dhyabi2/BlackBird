# Vercel Production Readiness Checklist

This checklist covers what is required to run a **production VELA web client / API on Vercel** while keeping the heavy backend (indexer, guardian, prover) on Hostinger.

> VELA is still an unaudited prototype. Do not use it for mainnet funds without a full security review.

## Architecture split

| Layer | Vercel | Hostinger VPS |
|-------|--------|---------------|
| Static web UI | ✅ | ❌ |
| Serverless API routes (proxy, status, health) | ✅ | ❌ |
| Nano RPC queries (via `rpc.nano.to`) | ✅ (server-side) | optional |
| Real-time confirmations (via `wss://ws.nano.to`) | ✅ (browser) | ❌ |
| Indexer / guardian / FROST nodes | ❌ | ✅ |
| ZK proof generation | ⚠️ roadmap / remote proxy | ✅ |
| Persistent state database | ❌ (use Redis/Postgres) | ✅ or separate DB host |

## Required accounts and keys

- [x] Vercel account + project connected to GitHub repo.
- [x] Hostinger VPS running the VELA backend (indexer, guardian, coordinator/prover).
- [x] `rpc.nano.to` API key (`NANO_RPC_KEY`).
- [x] VELA backend API key (`VELA_BACKEND_API_KEY`).
- [ ] (Optional) Upstash Redis for cross-region rate limiting.

## Environment variables

Copy `web/.env.example` to `web/.env.local` and fill in production values in the Vercel dashboard.

```bash
# Nano RPC
NANO_RPC_ENDPOINT=https://rpc.nano.to
NANO_RPC_KEY=your_rpc_key_here

# VELA backend on Hostinger
VELA_BACKEND_URL=https://vela-backend.yourhostingerdomain.com
VELA_BACKEND_API_KEY=your_backend_key_here

# Rate limiting (optional but recommended)
UPSTASH_REDIS_REST_URL=https://...upstash.io
UPSTASH_REDIS_REST_TOKEN=...

# Public app config
NEXT_PUBLIC_APP_NAME=VELA v2
NEXT_PUBLIC_APP_URL=https://vela-web.vercel.app
```

## Vercel API routes

| Route | Method | Description |
|-------|--------|-------------|
| `/api/health` | GET | Vercel + Nano RPC health |
| `/api/status` | GET | Pool status from Hostinger backend |
| `/api/greenlight` | GET | Strict pre-deposit check: Nano RPC + backend health |
| `/api/balance` | GET | Nano account balance via `rpc.nano.to` |
| `/api/account_info` | GET | Nano account info (frontier, rep, balance; handles unopened accounts) |
| `/api/pending` | GET | Pending/receivable blocks for an account |
| `/api/pool_address/[denom]` | GET | Pool public key for a denomination |
| `/api/deposit` | POST | Submit deposit/commit hashes to backend |
| `/api/deposit_status` | GET | Check whether a commitment is indexed |
| `/api/withdraw` | POST | Submit ZK proof and request guardian signature |
| `/api/prove` | POST | Generate a Groth16 proof remotely on the backend |
| `/api/broadcast` | POST | Publish a signed Nano block via `rpc.nano.to` |
| `/api/work` | POST | Generate Nano PoW for a block hash |

## Pre-deployment checks

- [x] `npm run build` passes locally inside `web/`.
- [x] `npm run lint` passes.
- [x] All API routes return JSON and handle errors gracefully.
- [x] Backend is reachable from Vercel and returns valid responses.
- [x] `NANO_RPC_KEY` is not exposed to the browser (only used server-side).

## Security

- [x] Security headers configured in `next.config.ts`:
  - `Strict-Transport-Security`
  - `X-Frame-Options: DENY`
  - `X-Content-Type-Options: nosniff`
  - `Referrer-Policy: strict-origin-when-cross-origin`
  - `Permissions-Policy`
  - `Content-Security-Policy` (includes `wss://ws.nano.to`)
- [x] CORS restricted to `NEXT_PUBLIC_APP_URL`.
- [x] API routes validate input with Zod.
- [x] Rate limiting fallback on public routes (Redis optional).
- [x] No secrets logged or returned in error messages.
- [x] Mainnet-risk warnings shown in UI.

## Performance and reliability

- [x] Nano RPC calls use short-lived HTTPS requests (no `Session` keep-alive in serverless).
- [x] API routes timeout within Vercel limits (10 s Hobby / 60 s Pro / 900 s Enterprise).
- [x] ZK proving is **not** done inside Vercel functions.
- [x] Backend health endpoint is monitored via `/api/greenlight`.
- [ ] Error tracking (e.g., Sentry) integrated.
- [ ] Vercel Analytics / Log Drains configured.

## UX and flow

- [x] Wallet creation/restore with browser-encrypted seed.
- [x] Real-time funding detection via WebSocket (`wss://ws.nano.to`).
- [x] Auto-receive of pending sends before deposit (handles unopened source accounts).
- [x] Auto-detection of indexed deposits and automatic withdraw enable.
- [x] Minimal user inputs: password, external funding, two taps (deposit, withdraw).
- [x] Strict green-light check before exposing the deposit address or QR.

## DNS and domains

- [ ] Custom domain added in Vercel dashboard.
- [ ] DNS records point to Vercel.
- [ ] HTTPS / SSL enabled by Vercel.

## Post-deployment verification

- [x] `GET /api/health` returns `{"ok":true}`.
- [x] `GET /api/status` returns pool state from backend.
- [x] `GET /api/greenlight` returns `{"ok":true}`.
- [x] `GET /api/pool_address/1000000000000000000000000000000` returns a public key.
- [x] `/wallet` page loads and derives addresses from a test seed.
- [ ] Deposit and withdraw flows work end-to-end with a funded test account.
- [ ] Rate limit blocks abuse after threshold.

## Known limitations on Vercel

- No persistent filesystem across invocations.
- Serverless functions cannot run background daemons.
- Raw TCP outbound may be blocked; use HTTPS RPC only.
- Large circuit artifacts (`zkey`, `wasm`) should be served from a CDN, not bundled into functions.

## Next steps after this checklist

1. Move proof generation to WASM in the browser to remove backend proving trust.
2. Add automated E2E tests against a staging backend.
3. Implement multi-guardian / FROST threshold signing.
