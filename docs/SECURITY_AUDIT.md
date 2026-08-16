# VELA v2 Security Audit — Validations & Break Attempts

**Scope:** Next.js frontend (`web/`), Python backend (`src/`), deployment scripts/config, and infrastructure.  
**Date:** 2026-08-16  
**Commit audited:** `main` (`c1304d8`)

---

## Methodology

1. Inventory every security control / validation found in the code (input validation, auth, rate limiting, crypto checks, state integrity, deployment hardening).
2. For each control, attempt a concrete bypass or abuse locally / read-only against the deployed test environment.
3. Record evidence (curl output, code snippets, computed values) and rate severity.

---

## 1. Frontend API Routes

### 1.1 `/api/pool_address/[denomination]` — dynamic segment not validated

**Control intended:** Return the pool public key for a supported denomination.  
**Location:** `web/src/app/api/pool_address/[denomination]/route.ts`

**Break attempt:** Pass a path-traversal payload as the denomination.

```bash
curl -s "https://velav2-web.vercel.app/api/pool_address/..%2Fstatus"
```

**Result:** The route returns the `/api/status` response instead of a pool address, confirming the dynamic segment is forwarded verbatim into the backend URL.

```json
{"epoch":20681,"pool_pubkey":"cdd46face74c2d16dcf2d21db00687b8cf8ef56acd3445d1d2293a7a9e44a665","roots":...}
```

**Impact:** SSRF / path traversal against the VELA backend using the frontend’s own API key.  
**Severity:** High

---

### 1.2 `/api/broadcast` — accepts arbitrary Nano blocks

**Control intended:** Broadcast a client-built Nano block.  
**Location:** `web/src/app/api/broadcast/route.ts`

**Break attempt:** POST a clearly invalid state block.

```bash
curl -s -X POST https://velav2-web.vercel.app/api/broadcast \
  -H "Content-Type: application/json" \
  -d '{"block":{"type":"state","account":"nano_11111111111111111111111111111111111111111111111111111111111","previous":"0","representative":"nano_11111111111111111111111111111111111111111111111111111111111","balance":"0","link":"0","signature":"0","work":"0"}}'
```

**Result:** The block is forwarded to the Nano RPC and the RPC error is returned.

```json
{"error":"Nano RPC error: Block is invalid"}
```

**Impact:** Anyone can consume the project’s paid RPC quota and probe the RPC with arbitrary payloads.  
**Severity:** Medium

---

### 1.3 Rate limiting — optional Upstash, no fallback

**Control intended:** 20 req/min per IP via Upstash Redis.  
**Location:** `web/src/lib/rate-limit.ts`

**Break attempt:** The production `.env.local` has no Upstash variables. Calling public routes repeatedly (e.g. `/api/fee`) returns no rate-limit headers and never blocks.

**Impact:** All public API routes are unrate-limited in production.  
**Severity:** Medium

---

### 1.4 `/api/health` — leaks client IP and Nano node vendor

**Control intended:** Health check.  
**Location:** `web/src/app/api/health/route.ts`

**Break attempt:**

```bash
curl -s https://velav2-web.vercel.app/api/health
```

**Result:**

```json
{"ok":true,"timestamp":"2026-08-16T13:10:57.843Z","nano":{"reachable":true,"vendor":"Nano V28.1"},"ip":"37.41.38.242"}
```

**Impact:** Minor information disclosure.  
**Severity:** Low

---

### 1.5 Input validation weaknesses

| Route | Validation | Bypass |
|-------|-----------|--------|
| `/api/withdraw` | `proof: z.any()` | Any size/structure accepted and forwarded. |
| `/api/broadcast` | `block: z.record(z.string(), z.any())` | Values can be nested objects, arrays, etc. |
| `/api/work` | `difficulty` optional string | No format check; arbitrary strings forwarded. |
| `/api/deposit_status` | param presence only | Arbitrary strings forwarded to backend. |

---

### 1.6 Nano RPC key sent to public fallbacks

**Control intended:** Use `NANO_RPC_ENDPOINT` with key.  
**Location:** `web/src/lib/nano-rpc.ts`

**Finding:** The code retries against hardcoded public fallbacks (`proxy.nanos.cc`, `node.somenano.com`, `rainstorm.city`) and sends the operator’s `NANO_RPC_KEY` in both the `Authorization` header and the JSON body to every fallback.

**Impact:** If the primary endpoint fails, the paid RPC key is disclosed to third-party node operators.  
**Severity:** High

---

### 1.7 Content Security Policy

**Control intended:** Mitigate XSS.  
**Location:** `web/next.config.ts`

**Finding:** `script-src` includes `'unsafe-eval'` and `'unsafe-inline'`; `style-src` includes `'unsafe-inline'`; `connect-src` allows `https://*.upstash.io`.

**Impact:** CSP is largely neutered as an XSS defense and allows overly broad outbound connections.  
**Severity:** Medium

---

## 2. Backend (Python)

### 2.1 `/submit` bypasses API-key protection

**Control intended:** `@require_api_key` protects `/api/deposit`.  
**Location:** `src/vela_indexer.py` lines 220–230 vs 388–395

**Break attempt:** Call `/submit` without any key.

```bash
curl -s -X POST http://srv1906844.hstgr.cloud/submit \
  -H "Content-Type: application/json" \
  -d '{"deposit_hash":"0","commit_hash":"0"}'
```

**Result:** Route is reachable; it rejects the invalid pair but does not require authentication.

```json
{"error":"invalid pair"}
```

By contrast, the equivalent `/api/deposit` route returns:

```json
{"error":"unauthorized"}
```

**Impact:** Attackers can submit deposit/commitment pairs without the backend key, enabling spam / tree bloat.  
**Severity:** High

---

### 2.2 Deposit/commitment pair validation is weak

**Control intended:** Verify a real deposit and its commitment block before indexing.  
**Location:** `src/vela_indexer.py` lines 144–180

**Findings:**
- Does not verify `commit_block.previous == deposit_hash`.
- Does not verify the deposit block actually reduces the sender’s balance (could be any state block whose `link` equals the pool pubkey).
- Does not require the blocks to be confirmed.
- Epoch is taken from `local_timestamp`, which can drift.

**Impact:** Unconfirmed, unrelated, or manipulated block pairs can be indexed.  
**Severity:** High

---

### 2.3 Guardian `/withdraw` is unauthenticated

**Control intended:** Only the indexer should request withdrawals.  
**Location:** `src/vela_guardian.py` lines 188–195

**Finding:** The guardian exposes `/withdraw` with no API key. It is reachable over Tor. Anyone with a valid Groth16 proof can call it directly, bypassing the indexer entirely.

**Impact:** Bypasses indexer API-key gate and any future rate limiting.  
**Severity:** High

---

### 2.4 Double-spend race condition

**Control intended:** `spent_nullifiers` set prevents reusing a nullifier.  
**Location:** `src/vela_guardian.py` lines 138–190

**Finding:** The check `if N in self.spent_nullifiers` is not protected by a lock and is not atomic with `add(N)`. Two concurrent `/withdraw` requests with the same nullifier can both pass the check before either is recorded.

**Impact:** Two signed withdrawal blocks for the same deposit.  
**Severity:** Critical

---

### 2.5 Pool address / guardian address mismatch

**Control intended:** Deposits go to the pool; guardian signs withdrawals from the pool.  
**Locations:** `src/vela_crypto.py` (`pool_address`), `src/vela_guardian.py` (seed-derived address)

**Break attempt:** Compute the guardian address (from the hard-coded test seed) and the pool addresses for each denomination.

```text
guardian address:        nano_1sd1mjk1t9cynhn6z74rqu5fisu7szukkq9zs3oimiom6yqnekzff1dj4aqi
pool_address(0.1 XNO):   nano_1yunzzyfw4fz6cb3bap4herb3xwjwrhmgq5jxtyu9u7b6367jhnza833au1k
pool_address(1 XNO):     nano_3mgnfypggm3f4ugh7nixp15ahg8hjutpombnaqax6cbthch6bbm7kg5ezdrp
pool_address(10 XNO):    nano_119murdd3kdqf8jteny8ebdon3wi5b1twhdr8te9chdm97ba4dhc9d65pjsu
pool_address(100 XNO):   nano_3h93f41qfur5jn8xofjs5h97qcczrza7gg6coi6q4e97xh3rjyxmht3ygz34
```

**Result:** The guardian address is **not** any of the pool addresses. The guardian cannot sign spends from the accounts that receive deposits. No funds are currently in the pool accounts (`Account not found` for all four), so no user deposits have been lost yet.

**Impact:** Any deposit sent to the displayed pool address would be unspendable by the guardian. This is a core protocol correctness bug.  
**Severity:** Critical

---

### 2.6 `/api/prove` learns user secrets

**Control intended:** Generate a ZK proof for the client.  
**Location:** `src/vela_indexer.py` lines 304–355

**Finding:** The endpoint receives `n`, `t`, `P_w`, `S_pub` — everything needed to link a deposit to a withdrawal. The backend prover learns the user’s secrets.

**Impact:** Privacy model is broken if the indexer/guardian is compromised or malicious.  
**Severity:** Critical (privacy)

---

### 2.7 State-file integrity

**Control intended:** Persist commitments and spent nullifiers.  
**Locations:** `src/vela_indexer.py` lines 72–95, `src/vela_guardian.py` lines 54–70

**Findings:**
- Non-atomic JSON write (`open(..., "w")`).
- On parse error, the indexer silently starts with empty state.
- Files are world-readable on the VPS (`644`).

**Impact:** Corrupting or deleting `guardian_state.json` resets the spent-nullifier set, enabling replay withdrawal.  
**Severity:** High

---

## 3. Deployment / Infrastructure

### 3.1 Secrets in source / Git

| Finding | Location |
|---------|----------|
| Live `NANO_RPC_KEY` in README | `README.md` lines 61, 67 |
| Hard-coded guardian seed in tracked file | `web/scripts/fund-guardian.mjs` line 7 |
| Plaintext test-wallet seeds on disk | `web/test-wallets.json` (gitignored but present) |
| Encrypted wallet committed | `web/nano-wallet.dat` (tracked) |
| Live keys on disk, world-readable | `web/.env.local` (`644`) |
| Keys copied to VPS by `deploy.sh` | `.env`, `.guardian_seed`, `.vela_api_key` |

### 3.2 VPS file permissions

```bash
ls -l /opt/vela/data
# -rw-r--r-- 501 staff  644 Aug 16 08:34 guardian_state.json
# -rw-r--r-- root root  677 Aug 16 08:33 indexer_state.json
```

State files are readable by any local user.

### 3.3 HTTP backend communication

**Finding:** `VELA_BACKEND_URL` in `web/.env.local` is `http://srv1906844.hstgr.cloud`. The `X-VELA-API-Key` is therefore sent unencrypted from Vercel to the VPS.

**Severity:** High

### 3.4 Systemd services run as root

**Location:** `config/vela-indexer.service`, `config/vela-guardian.service`

**Impact:** A compromise of either Flask app gives full root access.  
**Severity:** High

---

## Summary of Critical / High Findings

| # | Finding | Severity |
|---|---------|----------|
| 1 | Pool address / guardian address mismatch — deposits go to unspendable accounts | Critical |
| 2 | `/api/prove` receives user secrets, breaking ZK privacy | Critical |
| 3 | Guardian double-spend race (no lock around nullifier check + mark) | Critical |
| 4 | `/submit` bypasses API-key protection | High |
| 5 | Path traversal / SSRF in `/api/pool_address/[denomination]` | High |
| 6 | Nano RPC key leaked to public fallback endpoints | High |
| 7 | State files non-atomic, silently resettable, world-readable | High |
| 8 | Guardian `/withdraw` unauthenticated over Tor | High |
| 9 | Backend communicates over HTTP (API key in cleartext) | High |
| 10 | Hard-coded live secrets in README / tracked scripts | High |
| 11 | Services run as root | High |

---

## Recommended Next Steps

1. **Stop real-fund deposits** until the pool/guardian address mismatch is resolved.
2. Rotate all leaked keys (Nano RPC, VELA backend API key, Vercel tokens).
3. Decide the correct pool address architecture (guardian-controlled address vs. derivable pool address) and align the circuit, indexer, and frontend.
4. Add API-key authentication to guardian `/withdraw`.
5. Protect or remove the `/submit` endpoint.
6. Add atomic state writes, backups, and strict file permissions.
7. Remove public RPC fallbacks or stop sending the API key to them.
8. Use HTTPS for the backend URL and add TLS to the VPS.
9. Run services as a dedicated non-root user.
10. Move all secrets out of the repo and README; scrub Git history if the keys are still active.
