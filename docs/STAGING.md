# VELA v2 Staging Environment

A staging environment lets you test deposits and withdrawals without touching the production pool or mainnet users.

## Recommended split

| Component | Production | Staging |
|-----------|------------|---------|
| Web app | `velav2-web.vercel.app` | `velav2-staging.vercel.app` (separate Vercel project) |
| Backend VPS | `srv1906844.hstgr.cloud` | Same host on different ports, or a second small VPS |
| Nano RPC | `rpc.nano.to` | Same (use a separate API key if you have one) |
| Pool / guardian key | Production seed | A different seed so the pool address is different |

## Option A: Staging backend on the same VPS (fastest)

1. Copy the systemd services to new ports:
   - `vela-indexer-staging.service` on `127.0.0.1:8082`
   - `vela-guardian-staging.service` on `127.0.0.1:8083`
2. Use a different `.env.staging` file with a different `GUARDIAN_SEED`.
3. Update Caddy to reverse-proxy a staging subdomain (e.g., `staging.srv1906844.hstgr.cloud`) to `localhost:8082`.
4. Deploy code with `VELA_BACKEND_URL=https://staging.srv1906844.hstgr.cloud/api`.

## Option B: Separate staging VPS

1. Provision a second Ubuntu VPS.
2. Run `scripts/setup_vps.sh` on it.
3. Set a different `GUARDIAN_SEED` so the pool address differs from production.
4. Update `scripts/deploy.sh` or create `scripts/deploy-staging.sh` pointing to the new host.

## Staging Vercel project

1. Create a new project in Vercel and import the same GitHub repo.
2. Set the **Root Directory** to `web`.
3. Add environment variables from `web/.env.example`, pointing to the staging backend.
4. Deploy. Preview deployments also work for branch testing.

## Testing checklist

- [ ] `/api/health` and `/api/greenlight` return `ok`.
- [ ] `/api/status` returns a different `pool_pubkey` than production.
- [ ] A funded test wallet can complete deposit → withdraw end-to-end.
- [ ] WebSocket funding detection fires when a send to the source address confirms.
- [ ] Auto-receive works for an unopened source account.
- [ ] Invalid blocks (bad work, bad subtype) are rejected.

## Getting test funds

- Use the `nano-wallet` CLI faucet for small amounts:
  ```bash
  npm install -g @nano/wallet
  export NANO_RPC_KEY=...
  nano-wallet generate --file staging.dat
  nano-wallet faucet --file staging.dat
  ```
- For larger denominations, send from a wallet you control to the test source address.

## Notes

- Never reuse the production guardian seed in staging. A different seed means a different pool address, so staging activity cannot be confused with production.
- The current prototype stores indexer state in `data/indexer_state.json` on disk. Keep staging and production data directories separate (use `--data-dir` or separate VPS).
