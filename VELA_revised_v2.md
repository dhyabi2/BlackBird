# VELA v2 — A Working Layer-2 Privacy Protocol for Nano (XNO)

**Version 2.0 — Revised Specification**

This document is a corrected, self-contained specification for VELA, a layer-2 privacy protocol that runs on the public Nano network without changing the Nano protocol. It fixes the protocol-breaking errors in the v1.0 draft (incorrect Nano address encoding, invalid burn-account assumptions, broken stealth-address math, impossible deposit embedding, and inconsistent ZK/Merkle hashing) and replaces the unsustainable economic claims and inflated Monero comparison with honest, quantified trade-offs.

---

## Revision Notes (what changed from v1.0)

| v1.0 defect | v2.0 fix |
|---|---|
| Base32 described as RFC 4648 upper-case. | Uses Nano’s actual base32 alphabet and Blake2b-40 checksums. |
| `nano_1111…1111` used as data account (missing checksum; all-zero pubkey). | Uses a hash-to-curve derived, provably unspendable protocol account; all data-account examples include valid checksums. |
| Stealth address formula used payee private key `b`. | Uses standard ECDH construction `P = H(rA)·G + B`, which only requires public keys. |
| Deposit embedded commitment `C` in send `link` field. | Uses a valid two-transaction deposit: `deposit_tx` to pool, plus `commit_tx` from same source to a burn address encoding `C`. |
| Merkle tree used BLAKE2b, circuit used Poseidon. | Both tree and circuit use Poseidon over BN254. |
| Claimed ~300k constraints / 2 s proving. | Provides realistic conservative estimates and calls for benchmarks. |
| Guardian bond 10 XNO vs operator stake 1000 XNO. | Harmonized at 1000 XNO with explicit fee and DAO-governance model. |
| Unspecified “airdrop token.” | Removed; incentives are in XNO with honest sustainability analysis. |
| Simulator modeled a 30-second custodial mixer. | Simulator models the actual epoch-based ZK pool. |
| “Strictly stronger than Monero on every axis.” | Balanced comparison acknowledging latency and trust trade-offs. |

---

## 0. Conventions

### 0.1 Nano primitives

All curve operations use **Ed25519** (Nano’s signature curve). `G` is the standard base point; `L` is the prime subgroup order.

Nano addresses use a **custom base32** encoding:
- Alphabet: `13456789abcdefghijkmnopqrstuwxyz`.
- Public key part: 52 characters encoding a 260-bit value (256-bit pubkey plus 4 zero padding bits). The first character is therefore always `1` or `3`.
- Checksum: 8 characters encoding the first **5 bytes** (Blake2b-40) of `Blake2b(public_key)`, reversed before encoding.
- Canonical regex: `^(nano|xrb)_[13]{1}[13456789abcdefghijkmnopqrstuwxyz]{59}$`.
- A valid Nano address is **65 characters** including the prefix.

Nano raw unit: `1 XNO = 10^30 raw`. All amounts in this spec are in raw unless marked XNO.

Nano state block semantics:
- `type` is always `"state"`.
- For a **send**, the `link` field MUST be the 32-byte public key of the destination account.
- For a **receive**, the `link` field is the hash of the send block being received.
- The `representative` field is a Nano address that becomes the account’s representative; it may be changed by any block.

### 0.2 Global constants

| Constant | Value | Meaning |
|---|---|---|
| `PROTOCOL_TAG` | `"vela_v2"` | version tag in all domain strings |
| `DOMAIN_STEALTH` | `"vela/v2/stealth"` | stealth shared-secret derivation |
| `DOMAIN_DEPOSIT` | `"vela/v2/deposit"` | deposit commitment |
| `DOMAIN_NULL` | `"vela/v2/nullifier"` | nullifier derivation |
| `DOMAIN_ROOT` | `"vela/v2/root"` | epoch root |
| `DOMAIN_DATA` | `"vela/v2/data"` | protocol-data account derivation |
| `MERKLE_DEPTH` | `20` | up to 1,048,576 commitments per epoch per denom |
| `EPOCH_SECONDS` | `86400` | 24 h mixing epoch |
| `HOPS_DEFAULT` | `3` | recommended pool hops |
| `DELAY_MIN` | `3600` | minimum withdraw delay (1 h) |
| `DELAY_MAX` | `172800` | maximum withdraw delay (48 h) |
| `BATCH_WINDOW` | `5` | seconds over which withdrawals are batched |
| `GUARDIAN_N` | `7` | total guardians |
| `GUARDIAN_M` | `5` | threshold for signing |
| `GUARDIAN_BOND` | `1000 × 10^30` raw (1000 XNO) | slashable bond |
| `WITHDRAW_FEE` | `0.01 × 10^30` raw (0.01 XNO) | guardian fee per withdrawal |
| `ANNOUNCE_DUST` | `1` raw | amount for protocol-data / tag transactions |

Pool denominations (fixed): `{ 0.1, 1, 10, 100 }` XNO, i.e. `{10^29, 10^30, 10^31, 10^32}` raw.

---

## 1. Architecture

```
┌─────────────────────────────────────────────┐
│         PUBLIC NANO NETWORK                 │
│  (unchanged state blocks, ORV consensus)    │
└───────┬─────────────────────┬───────────────┘
        │                     │
┌───────▼────────┐   ┌────────▼─────────┐
│ VELA INDEXERS  │   │ POOL GUARDIANS   │
│ (read-only;    │   │ (FROST threshold │
│  anyone can    │   │  signing + ZK    │
│  run one)      │   │  verification)   │
└───────┬────────┘   └────────┬─────────┘
        │                     │
┌───────▼─────────────────────▼───────────────┐
│              VELA CLIENT                    │
│  key manager • stealth engine • pool client │
│  ZK prover • Tor/I2P transport              │
└─────────────────────────────────────────────┘
```

Layers:
1. **Stealth layer** — one-time receiving addresses hide the recipient.
2. **Mixing layer** — fixed-denomination deposits and ZK-verified, threshold-signed withdrawals hide the sender and amount.
3. **Transport layer** — Tor/I2P/mixnet for network-level privacy.
4. **Obfuscation layer** — randomized delays, decoy traffic, address churn.

VELA changes nothing in Nano consensus. Every on-chain action is a standard Nano state block.

---

## 2. Keys and Identity

A user has two independent 32-byte seeds:
- `seed_view` — derives receiving/scan keys.
- `seed_spend` — derives spending keys.

Key derivation (role-separated):
```
priv = BLAKE2b-512(seed || role_byte || uint32le(index))[0:32] mod L
pub  = priv · G
```

Roles:
- `0x01` scan key `a` / `A`
- `0x02` spend key `b` / `B`
- `0x03` ephemeral payment key `r` / `R`
- `0x04` one-time deposit source account `s` / `S`

The public `VelaID` is the pair `(A, B)`. It is shared out-of-band (QR, secure message, etc.) and never appears on the Nano ledger.


---

## 3. Stealth Address Layer

Goal: hide the recipient and prevent address reuse / clustering.

### 3.1 Payee keys

From `seed_view`:
```
a = PRIVKEY(seed_view, 0x01, 0)   # scan scalar
A = a · G                          # scan public key
b = PRIVKEY(seed_view, 0x02, 0)   # spend scalar
B = b · G                          # spend public key
```

Publish `VelaID = (A, B)`.

### 3.2 One-time payment address

Payer has `VelaID = (A, B)`.

```
r = random scalar in [1, L-1]
R = r · G
shared = BLAKE2b-256(DOMAIN_STEALTH || (r · A))     # payer computes rA
       = BLAKE2b-256(DOMAIN_STEALTH || (a · R))     # payee computes aR
H_s    = scalar(shared) mod L                       # interpret hash as scalar
P      = H_s · G + B                                # one-time public key
p      = H_s + b mod L                              # one-time private key
```

The payer sends the payment amount to `nano_address(P)`.

The payer must communicate `R` to the payee. By default this is done via an on-chain **stealth tag** (§3.4). For stronger privacy, `R` may be sent off-chain (Nostr NIP-17, mixnet).

### 3.3 Scanning

The payee downloads the full set of stealth tags (or their off-chain equivalents) and tests each candidate `R`:
```
shared = BLAKE2b-256(DOMAIN_STEALTH || (a · R))
H_s    = scalar(shared) mod L
P'     = H_s · G + B
```
If a confirmed send to `nano_address(P')` exists, the payee has received a payment and can spend it with `p = H_s + b`.

Scanning is local; the indexer never learns which tag matched.

### 3.4 Stealth tag publication

The payer, from a fresh throwaway account `T`, sends `ANNOUNCE_DUST` (1 raw) to the account whose public key is the ephemeral point `R`:
```
tag_account = nano_address(R)
```

```json
{
  "type": "state",
  "account": "nano_…T…",
  "previous": "<prevHashOfT>",
  "representative": "<T's representative>",
  "balance": "<prev_balance_of_T - 1>",
  "link": "<R 64 hex>",
  "signature": "<ed25519 sig>",
  "work": "<pow>"
}
```

Because `R = r·G` is a valid Ed25519 point, `tag_account` is a valid Nano address. The private key for `tag_account` is unknown (it would require solving for `r` from `R`, or for the discrete log of `R`), so the 1 raw is effectively burned.

Indexers maintain `TAG_LIST` of all 1-raw sends to valid Ed25519 points that are never subsequently spent. Clients download the full list over Tor and scan locally.

**Privacy note:** On-chain tags create temporal correlation. For high privacy, use off-chain tag delivery (Nostr NIP-17, Katzenpost, or a mixnet). The on-chain mode is retained because it requires no external infrastructure.

---

## 4. Decentralized Mixing Pool

Goal: hide the sender and break transaction graph taint. All deposits into a given pool use the same fixed denomination, so amounts within a pool are uniform.

### 4.1 Pool accounts

For each denomination `D`:
```
pool_seed_D = BLAKE2b-256("vela/v2/pool" || le64(D))
pool_point_D = hash_to_edwards(pool_seed_D)
pool_pubkey_D = pool_point_D.compress()
pool_account_D = nano_address(pool_pubkey_D)
```

The private key for `pool_account_D` is never assembled. Guardians generate it via FROST distributed key generation (§4.6).

### 4.2 Two-transaction deposit

A depositor mixing `D` raw performs two on-chain transactions from a fresh source account `S`:

1. **Deposit transaction** — send `D` raw to the pool:
```json
{
  "type": "state",
  "account": "nano_…S…",
  "previous": "<prev>",
  "representative": "<rep>",
  "balance": "<prev_balance_S - D>",
  "link": "<pool_pubkey_D 64 hex>",
  "signature": "<sig>",
  "work": "<pow>"
}
```

2. **Commitment transaction** — send 1 raw to a burn address encoding the commitment `C`. The depositor first computes:
```
n  = random 32 bytes                # nullifier secret
t  = random 32 bytes                # trapdoor
shared_w = BLAKE2b-256(DOMAIN_STEALTH || (r_w · A))
H_w      = scalar(shared_w) mod L
P_w      = H_w · G + B              # withdrawal one-time address
p_w      = H_w + b mod L

C_raw = BLAKE2b-256(DOMAIN_DEPOSIT || PROTOCOL_TAG || n || t || P_w || S_pub)
# Ensure C_raw is a valid Ed25519 compressed point; if not, re-sample t.
C = C_raw

commit_burn_account = nano_address(C)
```

```json
{
  "type": "state",
  "account": "nano_…S…",
  "previous": "<prev>",
  "representative": "<rep>",
  "balance": "<prev_balance_S - 1>",
  "link": "<C 64 hex>",
  "signature": "<sig>",
  "work": "<pow>"
}
```

`S` must be funded with at least `D + 1` raw plus PoW cost. `S` is never reused. If `S` holds exactly `D + 1` raw, the deposit transaction must be confirmed before the commitment transaction; otherwise either order is acceptable.

Guardians and indexers observe both transactions, verify they share the same source account `S`, occur in the same epoch `e = floor(block_timestamp / EPOCH_SECONDS)`, and that the deposit amount matches a supported denomination. They then add `C` to the epoch’s commitment set for denomination `D`.

### 4.3 Epoch Merkle tree

For each `(denomination D, epoch e)`, build a Merkle tree of depth `MERKLE_DEPTH` using **Poseidon over BN254**:
```
leaf_i = Poseidon(C_i, 0)
node   = Poseidon(left, right)
root_e_D = merkle_root(leaves sorted by C_i)
```

`root_e_D` is published on-chain as protocol data (§5) within the first hour of epoch `e+1`.

A depositor’s withdrawal proof is anchored to an on-chain `root_e_D`.

### 4.4 Withdrawal

After a random delay `τ` drawn from an exponential distribution with mean 24 h, clipped to `[DELAY_MIN, DELAY_MAX]`, the depositor submits a withdrawal request to the guardians’ bulletin board:
```
N = Poseidon(DOMAIN_NULL, n)              # nullifier
π = Groth16 proof for circuit Ψ (§4.5)
    public inputs:  root_e_D, N, P_w_enc
    private inputs: n, t, S_pub_enc, leaf_index, path[MERKLE_DEPTH]
```

Guardian verification (each of the `M` selected guardians independently):
1. Verify `π` against the on-chain `root_e_D`.
2. Verify `N` is not in the spent-nullifier set.
3. Verify `P_w` is a valid Ed25519 compressed point.
4. Verify the withdrawal amount matches the denomination `D`.

If all checks pass, the guardians jointly produce a FROST signature on the withdrawal block:
```json
{
  "type": "state",
  "account": "<pool_account_D>",
  "previous": "<prev>",
  "representative": "<pool rep>",
  "balance": "<pool_balance - (D - WITHDRAW_FEE)>",
  "link": "<P_w 64 hex>",
  "signature": "<FROST combined signature>",
  "work": "<pow>"
}
```

The pool sends `D - WITHDRAW_FEE` raw to `P_w`. The fee remains in the pool. Because every withdrawal of denomination `D` receives exactly the same reduced amount, output uniformity is preserved. Guardians periodically sweep accumulated fees from the pool to a `guardian_fee_account`. The nullifier `N` is recorded as spent.

**Batching.** Withdrawals approved within the same `BATCH_WINDOW` are submitted concurrently in random order with per-tx jitter to reduce timing correlation.


### 4.5 ZK circuit specification

Circuit `Ψ` is implemented in Circom 2 over BN254 with Groth16.

**Encoding.** Ed25519 public keys and scalars (32 bytes) are encoded as two BN254 field elements each: low 128 bits and high 128 bits. The circuit uses only Poseidon for hashing.

```
C      = Poseidon(DOMAIN_DEPOSIT, n_lo, n_hi, t_lo, t_hi,
                  P_w_lo, P_w_hi, S_pub_lo, S_pub_hi)
N      = Poseidon(DOMAIN_NULL, n_lo, n_hi)
leaf   = Poseidon(C, 0)
root   = MerklePoseidon(leaf, path[MERKLE_DEPTH], index[MERKLE_DEPTH])
```

The circuit checks:
1. `C` is correctly formed from `n`, `t`, `P_w`, `S_pub`.
2. `N` is correctly formed from `n`.
3. `leaf = Poseidon(C, 0)`.
4. `MerklePoseidon(leaf, path, index) == root`.

**Public inputs:** `root`, `N`, `P_w_lo`, `P_w_hi`.
**Private inputs:** `n_lo/hi`, `t_lo/hi`, `S_pub_lo/hi`, `path[MERKLE_DEPTH][2]`, `index[MERKLE_DEPTH]`.

**Performance estimate (conservative, to be benchmarked):**
- Poseidon width 11 (rate 8), ~350 constraints per permutation.
- Commitment: ~1 permutation.
- Nullifier: ~1 permutation.
- Merkle path: 20 permutations.
- Total: roughly **8,000–12,000 constraints**.
- Proving time on a modern laptop: **a few seconds**.
- Proof size: 192 bytes (Groth16).
- Verification time: < 10 ms.

These are estimates; an implementation must measure actual numbers.

### 4.6 Guardians and FROST threshold signatures

Guardians run a one-time FROST distributed key generation ceremony over Ed25519, producing a single public key `V = pool_pubkey_D` and secret shares such that any `GUARDIAN_M = 5` of `GUARDIAN_N = 7` can sign.

- No single guardian learns the full key.
- Every signing requires at least `M` independent verifications of the ZK proof and block validity.
- Guardians publish only Tor hidden services.

**Bond and fees.** Each guardian locks `GUARDIAN_BOND = 1000 XNO`. Because Nano has no native smart-contract layer, bond enforcement is social/DAO-based: a misbehaving guardian is removed by majority vote and its bond is distributed or burned according to off-chain governance. Each withdrawal pays `WITHDRAW_FEE = 0.01 XNO`, which funds guardian operation (VPS, bandwidth, maintenance).

**Recovery.** If fewer than `M` guardians remain online, withdrawals stall until a new DKG ceremony is performed and the old pool balance is swept to a new pool account by the remaining old guardians. This sweep is itself a VELA withdrawal and inherits the same anonymity properties.

---

## 5. Protocol Data and Burn Addresses

All protocol-level data (epoch roots, nullifiers, bulletin-board anchors) is published as 1-raw sends to provably unspendable burn addresses. The protocol account is derived by hash-to-curve:
```
vela_data_seed   = BLAKE2b-256(DOMAIN_DATA || PROTOCOL_TAG)
vela_data_point  = hash_to_edwards(vela_data_seed)
vela_data_pubkey = vela_data_point.compress()
vela_data_account = nano_address(vela_data_pubkey)
```

Individual data items are published to burn addresses derived similarly:
```
item_point  = hash_to_edwards(DOMAIN_DATA || item_type || le64(e) || le64(D) || item_bytes)
item_account = nano_address(item_point)
```

The indexer recognizes these by the pattern:
- amount == 1 raw,
- source is a recognized protocol signer (guardian or federation signer),
- destination is a valid curve point derived via the above hash-to-curve pattern.

Because the discrete log of a hash-to-curve point is unknown, these accounts are unspendable.

---

## 6. Transport and Obfuscation

### 6.1 Transport
- Tor or I2P is mandatory for all client/indexer/guardian connections.
- Federation and guardians expose only onion services.
- Clients query ≥ 3 independent nodes/indexers over distinct circuits and cross-check hashes.
- Optional mixnet (Nym, Katzenpost) for withdrawal submissions.

### 6.2 Timing decorrelation
- Receive delay before issuing a receive block: exponential, mean 12 h, clipped `[0, 48 h]`.
- Spend delay after a pool withdrawal: exponential, mean 12 h, clipped `[0, 48 h]`.
- Withdrawal delay: exponential, mean 24 h, clipped `[DELAY_MIN, DELAY_MAX]`.
- Batch submissions use random ordering and 0–500 ms jitter.

### 6.3 Decoy flood
Because Nano transactions are feeless, clients may generate decoy 1-raw sends between fresh burn addresses. However, this bloats the ledger; it is optional and should be used sparingly. Global decoy roots published by the federation are preferred.

### 6.4 Address rotation
Every output uses a fresh one-time address. The wallet never displays raw Nano addresses to users; only `VelaID`s.

---

## 7. Client Flows

### 7.1 Stealth payment
1. Payer obtains `VelaID = (A, B)`.
2. Payer creates/funds throwaway account `T`.
3. Payer computes `R, P` per §3.2.
4. Payer broadcasts payment to `nano_address(P)`.
5. Payer publishes stealth tag for `R` (§3.4), optionally off-chain.
6. Payee scans, finds `P`, waits receive delay, issues receive block.

### 7.2 Single pool hop
1. User creates/funds source account `S` with `D + 1` raw.
2. User computes `n, t, P_w, C` per §4.2.
3. User broadcasts `deposit_tx` (D raw to pool) and `commit_tx` (1 raw to burn address C) from `S`.
4. Epoch closes; guardians publish `root_e_D`.
5. After withdrawal delay, user builds proof `π` and posts `(e, N, P_w, π)` to bulletin board.
6. Guardians verify and FROST-sign withdrawal to `P_w`.
7. User waits spend delay, then spends `P_w`.

### 7.3 Multi-hop mix (recommended: 3 hops)
Repeat Flow 7.2, funding each hop’s source account from the previous hop’s withdrawal output. After `h` hops, an adversary’s traceability advantage is at best `(1/N)^h` against an ideal model, where `N` is the effective number of distinct commitments in the final hop’s epoch.


---

## 8. Parameters

| Parameter | Value | Rationale |
|---|---|---|
| `MERKLE_DEPTH` | 20 | up to 1M commitments per epoch per denom |
| `EPOCH_SECONDS` | 86400 | balances pool depth vs. latency |
| `HOPS_DEFAULT` | 3 | strong privacy without extreme delay |
| `DELAY_MIN / DELAY_MAX` | 1 h / 48 h | bounds worst-case latency |
| `BATCH_WINDOW` | 5 s | matches Nano confirmation time |
| `GUARDIAN_N / M` | 7 / 5 | tolerates 2 dishonest; collusion of 4 is harmless |
| `GUARDIAN_BOND` | 1000 XNO | aligned with operator stake |
| `WITHDRAW_FEE` | 0.01 XNO | covers guardian VPS/bandwidth |
| `ANNOUNCE_DUST` | 1 raw | minimal on-chain data cost |

**Expected on-chain footprint:**
- Stealth payment: 1 real send + 1 tag send + 1 receive = 3 state blocks.
- Single pool hop: 1 deposit + 1 commitment + 1 withdrawal + 1 receive = 4 state blocks.
- 3-hop mix: ~12 state blocks, plus tags/receives.

---

## 9. Failure Modes and Recovery

| Failure | Detection | Recovery |
|---|---|---|
| Guardian quorum unavailable | Heartbeat timeout (>30 min) | Queue withdrawals; new DKG sweeps old pool. |
| Malicious guardian signs invalid block | Public signed blocks; proof mismatch | DAO vote removes guardian; bond slashed socially. |
| Commitment without matching deposit | Indexer validation | Commitment rejected from tree. |
| Client loses `n, t` | Cannot construct proof | Funds remain in pool permanently. Wallet must encrypt and back up `(n, t, p_w)`. |
| Disputed epoch root | Multiple roots on-chain | Root with earlier on-chain timestamp wins; depositors may reference either root in proof. |
| Nano network stall | No quorum observations | VELA waits for 3 independent confirmations. |

---

## 10. Economic Model

VELA is not free to operate, but it can be low-cost. The protocol is funded by:

1. **Withdrawal fees.** Each withdrawal of denomination `D` receives `D - WITHDRAW_FEE`, where `WITHDRAW_FEE = 0.01 XNO`. The fee remains in the pool and is periodically swept by guardians. Because every withdrawal of the same denomination receives the identical reduced amount, output uniformity—and therefore anonymity—is preserved.
2. **Guardian bond.** `1000 XNO` locked stake aligns incentives. Misbehavior leads to removal and loss of future fee revenue; because Nano lacks smart contracts, bond slashing is enforced by DAO governance.
3. **Bootstrap grants.** Initial operator subsidies from community donations or the Nano ecosystem fund until volume reaches sustainability.

**Cost structure (realistic):**
- PoW per transaction: ~$0.00001 in electricity.
- Guardian VPS: ~$30/month.
- At 300 withdrawals/day per guardian, fee revenue ≈ 3 XNO/day ≈ $90/month at $1/XNO.

There is **no new token**. Incentives are denominated in XNO. The “0% service fee” claim in v1.0 is replaced with a transparent, low fee that keeps the protocol solvent.

---

## 11. Measurement and Validation Framework

### 11.1 Simulator
A Python event-driven simulator models:
- Users arriving at realistic rates.
- Fixed-denomination deposits into epochs.
- Random withdrawal delays.
- Guardian verification, batching, and FROST signing.
- Adversary with full ledger view.

### 11.2 Adversary model
The adversary observes:
- All on-chain transactions (amounts, timestamps, accounts).
- All protocol data (roots, nullifiers, commitments).
- Optionally, IP-level metadata if transport fails (Tor/I2P bypass).

Attacks:
- Timing correlation.
- Amount matching (defeated by fixed denominations within a pool).
- Graph clustering.
- Sybil injection.

### 11.3 Metrics
| Metric | Definition |
|---|---|
| `anonymity_set_size` | Number of distinct commitments in the withdrawal epoch. |
| `effective_anonymity` | `2^H` where `H` is Shannon entropy of the adversary’s candidate distribution. |
| `success_rate` | Fraction of withdrawals whose true source is the adversary’s top guess. |
| `latency` | Time from deposit to spendable output. |

### 11.4 Expected results (realistic)
With pool size `N = 500` and `h = 3` hops:
- Anonymity set per withdrawal: ~500.
- Ideal traceability advantage: ≤ `(1/500)^3 ≈ 8×10⁻⁹`.
- Real-world advantage (with timing/behavioral heuristics): higher; the simulator measures this.
- Latency: 2–5 days for a full 3-hop mix.

Compare to Monero ring size 16: VELA can offer a larger anonymity set at the cost of much higher latency and threshold trust in guardians.

---

## 12. Comparison with Monero (Honest)

| Property | Monero (XMR) | VELA on Nano (XNO) |
|---|---|---|
| Anonymity set per spend | Fixed 16 | Scales with pool size; target 100–1000+ |
| Amount privacy | RingCT hides exact amounts | Fixed denominations within pool; outputs are `D - fee` |
| Sender privacy | Ring signatures | Pool mixing + ZK proof |
| Recipient privacy | Stealth addresses | Stealth addresses (same family) |
| Latency | Seconds | Hours to days (epochs + delays) |
| Custodial trust | None; fully non-custodial | Threshold trust in 5-of-7 guardians |
| Cost | ~0.0002 XMR fee | Nano PoW + 0.01 XNO guardian fee |
| Network changes | Protocol-level (hard-forked) | None; pure layer-2 |

**Bottom line:** VELA can exceed Monero’s anonymity-set size if it attracts enough users, but it pays for that with latency, guardian trust, and a more complex user experience. It is not “strictly stronger on every axis”; it is stronger on anonymity-set scalability and weaker on latency and trust assumptions.

---

## 13. Deployment Checklist

1. Finalize `hash_to_edwards` implementation (RFC 9380 or vetted library) and derive `vela_data_account`.
2. Guardians perform FROST DKG for each pool denomination; publish `V` and Groth16 verifier keys.
3. Deploy ≥ 3 independent read-only indexers as Tor hidden services.
4. Deploy bulletin board as Tor hidden service, signed by guardians.
5. Build client wallet with:
   - `vela receive` — scan stealth tags.
   - `vela pay <VelaID> <amount>` — stealth payment.
   - `vela mix <denom> <hops>` — pool mixing.
6. Perform trusted Groth16 setup ceremony (powers-of-tau) for circuit `Ψ`.
7. Audit: circuit soundness, FROST implementation, transport defaults, address-reuse prevention.
8. Benchmark proving/verification times on representative hardware and update §4.5 with measured numbers.

---

*End of VELA v2 revised specification.*
