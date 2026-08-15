# VELA v2 Web Client

Production-ready Next.js web client for the VELA v2 Nano privacy pool.

## What runs where

- **Vercel**: This static/dynamic web UI and lightweight serverless API routes.
- **Hostinger VPS**: The VELA backend (indexer, guardian, coordinator/prover).
- **rpc.nano.to**: Nano RPC endpoint (server-side only).

## Setup

```bash
cd web
cp .env.example .env.local
# Edit .env.local with your keys
npm install
npm run dev
```

## Deploy to Vercel

1. Push the repo to GitHub.
2. Import the project in Vercel and set the **Root Directory** to `web`.
3. Add environment variables from `.env.example` in the Vercel dashboard.
4. Deploy.

## API routes

| Route | Method | Description |
|-------|--------|-------------|
| `/api/health` | GET | Vercel + Nano RPC health |
| `/api/status` | GET | Pool status from Hostinger backend |
| `/api/balance` | GET | Nano account balance via `rpc.nano.to` |
| `/api/deposit` | POST | Submit deposit receipt to backend |
| `/api/withdraw` | POST | Submit withdrawal proof to backend |
| `/api/prove` | POST | Proxy proof-generation request to backend |

## Security

- Environment variables are only accessed server-side.
- Security headers and CSP are configured in `next.config.ts`.
- Input validation uses Zod.
- Optional Upstash Redis rate limiting.
