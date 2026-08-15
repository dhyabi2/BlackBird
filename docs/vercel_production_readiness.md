# Vercel Production Readiness Checklist

This checklist covers what is required to run a **production VELA web client / API on Vercel** while keeping the heavy backend (indexer, guardian, prover) on Hostinger.

> VELA is still an unaudited prototype. Do not use it for mainnet funds without a full security review.

## Architecture split

| Layer | Vercel | Hostinger VPS |
|-------|--------|---------------|
| Static web UI | ✅ | ❌ |
| Serverless API routes (proxy, status, health) | ✅ | ❌ |
| Nano RPC queries (via `rpc.nano.to`) | ✅ (server-side) | optional |
| Indexer / guardian / FROST nodes | ❌ | ✅ |
| ZK proof generation | ⚠️ roadmap / remote proxy | ✅ |
| Persistent state database | ❌ (use Redis/Postgres) | ✅ or separate DB host |

## Required accounts and keys

- [ ] Vercel account + project connected to GitHub repo.
- [ ] Hostinger VPS running the VELA backend (indexer, guardian, coordinator/prover).
- [ ] `rpc.nano.to` API key (`NANO_RPC_KEY`).
- [ ] VELA backend API key (`VELA_BACKEND_API_KEY`).
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
| `/api/balance` | GET | Nano account balance via `rpc.nano.to` |
| `/api/account_info` | GET | Nano account info (frontier, rep, balance) |
| `/api/pool_address/[denom]` | GET | Pool public key for a denomination |
| `/api/deposit` | POST | Submit deposit/commit hashes to backend |
| `/api/withdraw` | POST | Submit ZK proof and request guardian signature |
| `/api/prove` | POST | Generate a Groth16 proof remotely on the backend |
| `/api/broadcast` | POST | Publish a signed Nano block via `rpc.nano.to` |
| `/api/work` | POST | Generate Nano PoW for a block hash |

## Pre-deployment checks

- [ ] `npm run build` passes locally inside `web/`.
- [ ] `npm run lint` passes.
- [ ] All API routes return JSON and handle errors gracefully.
- [ ] Backend is reachable from Vercel and returns valid responses.
- [ ] `NANO_RPC_KEY` is not exposed to the browser (only used server-side).

## Security

- [ ] Security headers configured in `next.config.ts`:
  - `Strict-Transport-Security`
  - `X-Frame-Options: DENY`
  - `X-Content-Type-Options: nosniff`
  - `Referrer-Policy: strict-origin-when-cross-origin`
  - `Permissions-Policy`
  - `Content-Security-Policy`
- [ ] CORS restricted to `NEXT_PUBLIC_APP_URL`.
- [ ] API routes validate input with Zod.
- [ ] Rate limiting enabled on public routes.
- [ ] No secrets logged or returned in error messages.
- [ ] Mainnet-risk warnings shown in UI.

## Performance and reliability

- [ ] Nano RPC calls use short-lived HTTPS requests (no `Session` keep-alive in serverless).
- [ ] API routes timeout within Vercel limits (10 s Hobby / 60 s Pro / 900 s Enterprise).
- [ ] ZK proving is **not** done inside Vercel functions unless using a very small circuit under timeout.
- [ ] Backend health endpoint is monitored.
- [ ] Error tracking (e.g., Sentry) integrated.
- [ ] Vercel Analytics / Log Drains configured.

## DNS and domains

- [ ] Custom domain added in Vercel dashboard.
- [ ] DNS records point to Vercel.
- [ ] HTTPS / SSL enabled by Vercel.

## Post-deployment verification

- [ ] `GET /api/health` returns `{"ok":true}`.
- [ ] `GET /api/status` returns pool state from backend.
- [ ] `GET /api/pool_address/1000000000000000000000000000000` returns a public key.
- [ ] `/wallet` page loads and derives addresses from a test seed.
- [ ] Deposit and withdraw flows work end-to-end with a funded test account.
- [ ] Rate limit blocks abuse after threshold.

## Known limitations on Vercel

- No persistent filesystem across invocations.
- Serverless functions cannot run background daemons.
- Raw TCP outbound may be blocked; use HTTPS RPC only.
- Large circuit artifacts (`zkey`, `wasm`) should be served from a CDN, not bundled into functions.

## Next steps after this checklist

1. Implement browser-side wallet integration (seed / private key input with strong warnings).
2. Move proof generation to WASM in the browser to remove backend proving trust.
3. Add automated E2E tests against a staging backend.
