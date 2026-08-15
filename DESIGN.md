# VELA v2 Design

A decentralized privacy layer for Nano (XNO). Users deposit into a common pool and later withdraw to fresh addresses using Groth16 zero-knowledge proofs. No single machine ever controls the pool key.

## Table of Contents

1. [Goals and Non-Goals](#1-goals-and-non-goals)
2. [Trust Model](#2-trust-model)
3. [Architecture Overview](#3-architecture-overview)
4. [Cryptographic Primitives](#4-cryptographic-primitives)
5. [Deposit Flow](#5-deposit-flow)
6. [Indexer Network](#6-indexer-network)
7. [Guardian Network](#7-guardian-network)
8. [Withdrawal Flow](#8-withdrawal-flow)
9. [Censorship Resistance](#9-censorship-resistance)
10. [Privacy Model](#10-privacy-model)
11. [Economic Security](#11-economic-security)
12. [Client Performance](#12-client-performance)
13. [Deployment and Operations](#13-deployment-and-operations)
14. [BPMN Model](#14-bpmn-model)
15. [Critical Design Area Analyses](#15-critical-design-area-analyses)

---

## 1. Goals and Non-Goals

### Goals

- Hide the link between a deposit and a withdrawal.
- Require no trusted single party for custody, liveness, or proof verification.
- Remain fully automated: no hardware wallets, no manual button presses, no private networks.
- Use Nano as the base settlement layer.

### Non-Goals

- Perfect anonymity with small pools. Privacy grows with the number of users in an epoch.
- Hiding withdrawal amounts or recipients. Amounts are fixed denominations; recipients should be fresh addresses.
- Replacing Nano consensus. Nano ORV remains the base-layer trust assumption.

---

## 2. Trust Model

The protocol removes single-party trust from custody and indexing:

| Function | Trust Replacement |
|----------|-------------------|
| Pool custody | `t-of-n` FROST threshold signing over Ed25519-blake2b. No single guardian holds the full key. |
| Merkle root computation | Deterministic, replicated across independent indexers; roots published on-chain and served via API. |
| Proof verification | Deterministic Groth16 verification inside each guardian. |
| Nullifier tracking | Replicated nullifier set; double-spends rejected by any honest guardian. |
| Network transport | Public internet or Tor hidden services; no private networks. |

Remaining assumptions:

- Nano consensus is secure and final.
- At most `t-1` guardians are malicious or compromised.
- Standard cryptography is secure: Poseidon, BN254 Groth16, Ed25519-blake2b, FROST.

---

## 3. Architecture Overview

```
┌─────────────┐     ┌─────────────┐     ┌─────────────────┐
│  Depositor  │     │  Withdrawer │     │   Nano Ledger   │
│   (client)  │     │   (client)  │     │  (base layer)   │
└──────┬──────┘     └──────┬──────┘     └─────────────────┘
       │                   │                     ▲
       │ deposit blocks    │ withdrawal block    │ confirms
       └───────────────────┼─────────────────────┘
                           │
       ┌───────────────────┴───────────────────┐
       │                                       │
       ▼                                       ▼
┌─────────────────────┐             ┌─────────────────────┐
│   Indexer Network   │             │   Guardian Network  │
│  (computes roots,   │             │  (t-of-n FROST      │
│   serves proofs)    │             │   threshold signers)│
└─────────────────────┘             └─────────────────────┘
```

Actors:

- **Client**: creates deposits, generates commitments, produces Groth16 proofs, broadcasts Nano blocks.
- **Indexer**: reads Nano blocks, validates deposit/commitment pairs, builds per-epoch Poseidon Merkle trees, publishes roots and proofs.
- **Guardian**: holds one FROST share; verifies ZK proofs, checks nullifiers, contributes a partial signature.
- **Coordinator**: collects partial signatures from `t` guardians and aggregates them into a single Ed25519-blake2b signature. The coordinator can be run by the withdrawer, an indexer, or any third party; it never holds a key share.

---

## 4. Cryptographic Primitives

1. **Poseidon hash over BN254** — used for commitments, nullifiers, and Merkle tree nodes.
2. **Groth16 zk-SNARK over BN254** — proves knowledge of a valid deposit and inclusion in a published root without revealing the secret.
3. **Ed25519-blake2b** — Nano's native signature scheme; the pool key and all user signatures use it.
4. **FROST threshold signing** — distributes the pool private key across `n` guardians; any `t` can sign.
5. **Stealth addresses** — one-time recipient keys derived from a view/spend key pair.

### Commitment

```
C = Poseidon(1, n_lo, n_hi, t_lo, t_hi, P_w_lo, P_w_hi, S_pub_lo, S_pub_hi)
```

- `1` is the domain tag for deposits.
- `n` is the nullifier secret.
- `t` is the trapdoor.
- `P_w` is the withdrawal public key.
- `S_pub` is the source public key.
- 32-byte values are split into two BN254 field elements.

### Nullifier

```
N = Poseidon(2, n_lo, n_hi)
```

### Merkle tree

- Leaf: `Poseidon(C, 0)`
- Parent: `Poseidon(left, right)`
- Depth: 20

---

## 5. Deposit Flow

1. The client generates a stealth withdrawal address `P_w`.
2. The client picks random `n` and `t`.
3. The client computes commitment `C`.
4. The client creates and signs a Nano state block sending the denomination from `S` to the pool address.
5. The client creates and signs a second Nano state block with `link = C`, proving the commitment.
6. Both blocks are broadcast to multiple independent Nano nodes.
7. Deposit finalizes when Nano confirms both blocks.

No indexer or guardian is involved during deposit.

---

## 6. Indexer Network

Indexers are stateless, deterministic services. Any honest indexer watching the Nano chain produces the same Merkle root.

### Responsibilities

- Scan confirmed Nano blocks for deposit/commitment pairs.
- Validate that a deposit transfers a supported denomination to the pool address.
- Validate that the commitment block links `C` and shares the same source account as the deposit.
- Build per-epoch, per-denomination Poseidon Merkle trees.
- Publish roots and serve inclusion proofs.
- Maintain a spent-nullifier set for its own queries.

### Root publication

Roots are published in two ways:

1. **API**: each indexer exposes `/root/<epoch>/<denom>` and `/proof/<epoch>/<denom>?C=<hex>`.
2. **On-chain**: each indexer publishes a `RootCommit` transaction on Nano for censorship-resistant availability and deterministic discovery.

A `RootCommit` transaction is a 0-value Nano state block sent by the indexer account to a protocol-defined publication address. It encodes:

| Field | Size | Meaning |
|-------|------|---------|
| `epoch` | 4 bytes | Epoch number |
| `denomination` | 8 bytes | Denomination in raw |
| `root` | 32 bytes | Poseidon Merkle root |
| `batch_commitment` | 32 bytes | Poseidon hash of ordered deposit-block hashes included |
| `prev_root_hash` | 32 bytes | Hash of the previous RootCommit this indexer extended |

Fields are packed into the available block data fields (e.g., `representative` or `link`) using a fixed encoding. Because RootCommit transactions are signed by the indexer and live on the Nano ledger, they provide:

- Immutable publication
- Censorship resistance
- Automatic indexer discovery (scan all senders to the publication address)
- Canonical ordering by confirmation height

### Root consensus

A client determines the canonical root for an epoch/denomination by:

1. Scanning RootCommit transactions from multiple indexer accounts.
2. Grouping roots by value.
3. Accepting the root that is published by a majority of known indexers.
4. Recomputing the root independently from public Nano data and verifying it matches.

If roots disagree, the client waits for more RootCommit transactions or recomputes the root itself from the ledger. Because root computation is deterministic, any divergence is attributable to a faulty or malicious indexer.

---

## 7. Guardian Network

The guardian network is a `t-of-n` FROST threshold signer set. The pool public key is the aggregate FROST public key; no single guardian knows the full private key.

### Responsibilities of each guardian

- Verify Groth16 proofs against accepted roots.
- Check that the nullifier is not already spent.
- Contribute a partial Ed25519-blake2b signature to a withdrawal block if and only if the proof and nullifier checks pass.

### FROST ciphersuite

Because Nano uses Ed25519-blake2b, the FROST implementation must use Blake2b for all internal hashes (nonce derivation, challenge computation). Standard Ed25519-SHA512 FROST libraries are incompatible with Nano.

To maximize assurance, the implementation is built on the audited **`frost-core`** crate and the well-tested **`frost-ed25519`** reference ciphersuite, with the following minimal substitutions to target Ed25519-blake2b:

| FROST internal hash | Default (SHA-512) | VELA (Blake2b) |
|---------------------|-------------------|----------------|
| Randomizer derivation (`hash_randomizer`) | BLAKE2b-512 / H3 context | BLAKE2b-512 with protocol-specific context string |
| Nonce derivation (`generate_nonce`) | BLAKE2b-512 / H3 context | BLAKE2b-512 with protocol-specific context string |
| Challenge computation (`challenge`) | BLAKE2b-512 / H2 context | BLAKE2b-512 with protocol-specific context string |

This limits the unaudited surface to the hash-function substitutions and the context strings, rather than a from-scratch FROST implementation. The ciphersuite uses:

- Ed25519 group operations unchanged from `frost-ed25519`.
- SHA-512 replaced by Blake2b-512 only where the Ed25519-blake2b variant requires it.
- Distinct context strings (e.g., `"VELA.frost-ed25519-blake2b-v1"`) to prevent cross-protocol replay.

### Key generation and share refresh

#### Prototype: trusted dealer

For the prototype, a **trusted dealer** distributes FROST shares to guardians. The dealer is trusted only at setup; it does not participate in signing and is destroyed after distribution. This lets the protocol use `frost-core`'s verifiable share generation and avoids the complexity of a production DKG before the ciphersuite is fully audited.

#### Production: asynchronous Feldman VSS DKG

For production, guardians run an **asynchronous Distributed Key Generation (DKG)** protocol. No single party ever knows the full private key.

1. Each guardian generates a random polynomial and computes Feldman commitments to its coefficients.
2. Commitments are broadcast over a public bulletin board (e.g., Nostr, a git repository, or the Nano ledger as small messages). A hash commitment round prevents anyone from choosing coefficients after seeing others' choices.
3. Each guardian privately sends a Shamir share to every other guardian and verifies received shares against the public commitments.
4. The aggregate public key is the sum of all individual public commitments. Each guardian's FROST share is the sum of the valid shares it received.

The protocol tolerates up to `t-1` malicious guardians, provided there is an honest majority for dispute resolution and a reliable broadcast channel.

#### Proactive share refresh

Periodically (e.g., weekly or after any membership change), guardians run a **proactive refresh**:

- Each guardian generates a new random polynomial with a zero constant term.
- They distribute fresh shares such that the sum of all zero-constant-term secrets is zero.
- Each guardian adds the new share to its old share, producing a refreshed share.
- The aggregate public key does not change, but old shares become useless to an attacker.

#### Membership changes

When guardians join or leave, the remaining guardians run a **re-sharing protocol** to generate new shares for the updated set without changing the pool public key. Old shares are explicitly revoked and must not be accepted by clients after the refresh completes.

### Network communication

Guardians expose their partial-signature endpoints as public HTTPS or Tor hidden services. They authenticate requests with their FROST public shares. No private network is required.

### Coordinator

The coordinator is an optional helper, not a trusted gatekeeper. The default mode is **client-as-aggregator**: the withdrawing client collects partial signatures and broadcasts the final Nano block itself. Any third-party coordinator is only a relay.

A coordinator may:

- Forward the withdrawal request to at least `t` guardians.
- Collect and return partial signatures to the client.
- Optionally aggregate and broadcast if the client delegates that step.

The coordinator **cannot**:

- Forge a signature (needs `t` guardians).
- Alter the recipient `P_w` after signatures are collected, because every partial signature is computed over the exact Nano block hash, which includes `P_w`.
- Censor a withdrawal permanently, because the client can contact guardians directly or use a different coordinator.

### Binding the recipient to the FROST message

To prevent front-running, the recipient `P_w` is bound to the signed message at three layers:

1. **ZK public signals**: the Groth16 public inputs include `P_w_lo` and `P_w_hi`, so the proof is valid only for that recipient.
2. **Withdrawal intent hash**: the client sends `H(P_w, nonce)` as part of the request; guardians verify that the Nano block they sign contains the matching `P_w`.
3. **FROST message**: guardians sign the hash of the fully assembled Nano withdrawal block, which encodes `P_w`. Changing `P_w` invalidates every partial signature.

### Parallel coordinators and races

Multiple coordinators may operate at once. A client can simultaneously submit the same withdrawal request to several coordinators and collect partial signatures from any `t` guardians. The first valid Nano block confirmed by the network spends the nullifier; later competing blocks with the same nullifier are rejected by guardians because the nullifier is already spent.

This race is not harmful to the withdrawing client: the confirmed block must use the `P_w` bound in the proof and intent hash, so an honest client's funds always arrive at the intended address.

### Nullifier racing and double-signing

A nullifier can only be spent once. The protocol enforces this at several layers:

1. **Guardian check**: before returning a partial signature, each guardian verifies that the nullifier is not already in its local spent set. Guardians also track "in-flight" nullifiers for which they have recently signed and reject duplicate signing attempts within a short window.
2. **Nano confirmation**: if two valid blocks spending the same nullifier are broadcast, Nano's Open Representative Voting confirms one first. The losing block is not confirmed; its nullifier remains unspent from the ledger's perspective.
3. **Post-confirmation rejection**: after the first block is confirmed, all honest guardians reject future signing requests for that nullifier.
4. **Slashing deterrent**: if two conflicting signed withdrawals are ever confirmed, the offending guardian signatures serve as fraud proofs. A supermajority of honest guardians can vote to revoke the misbehaving guardian's share via a re-sharing protocol and, if a multi-sig bond is used, move the bond to a protocol treasury or burn address (see Economic Security).

This design does not require a mempool or global timestamps. It relies on guardian vigilance and Nano's single-account-chain ordering: only one block per pool account can be confirmed at a given height.

---

## 8. Withdrawal Flow

1. The client reads the accepted Merkle root for the deposit's epoch and denomination.
2. The client fetches the inclusion proof for its commitment `C`.
3. The client generates a Groth16 proof with public inputs `(root, nullifier, P_w_lo, P_w_hi)` and private inputs `(n, t, S_pub, path, leafIndex)`.
4. The client assembles the unsigned Nano withdrawal block with recipient `P_w` and computes the withdrawal intent hash `H(P_w, nonce)`.
5. The client sends the withdrawal request `(proof, publicSignals, P_w, nonce, intent_hash, unsigned_block, epoch, denomination)` to at least `t` guardians (directly or via a coordinator).
6. Each guardian verifies:
   - the Groth16 proof;
   - that the root is accepted;
   - that the nullifier is unspent;
   - that `P_w` matches the public signals and the intent hash;
   - that the unsigned block encodes the correct `P_w`.
7. Each honest guardian returns a partial signature over the unsigned withdrawal block hash.
8. The client (or a delegated coordinator) aggregates `t` partial signatures into the final Ed25519-blake2b signature.
9. The final block is broadcast to Nano.
10. Nano confirms the withdrawal; the nullifier is now spent.

---

## 9. Censorship Resistance

VELA v2 is designed so that no single actor can permanently censor deposits or withdrawals. This section lists every censorship vector and the concrete mitigation applied to each.

### Deposits

Deposits are ordinary Nano transactions to the pool address. They need only Nano liveness; no indexer, guardian, or coordinator can block them.

### Indexer censorship

A malicious indexer can:

- refuse to accept a `deposit_hash`/`commit_hash` pair;
- publish a wrong or incomplete root;
- refuse to serve inclusion proofs.

**Mitigations:**

- Multiple independent indexers exist; clients query several and accept a root only when a majority (or at least two independent indexers) agree.
- Roots are deterministic: any honest party can recompute the root from public Nano ledger data.
- Indexers publish `RootCommit` transactions on Nano, making censorship visible and giving clients an immutable source of roots.
- Inclusion proofs can be mirrored to IPFS or other content-addressed storage for availability if indexers go offline.

### Guardian censorship

A guardian can refuse to sign a valid withdrawal. A minority of guardians (`< n-t+1`) cannot block a withdrawal.

**Mitigations:**

- `t-of-n` FROST threshold: any `t` honest guardians can produce a valid signature.
- Clients contact guardians directly; no coordinator can block all paths.
- A large, geographically and jurisdictionally diverse guardian set makes collusion harder.
- Persistent non-signers can be identified via public accountability logs and removed through the re-sharing/rotation protocol.
- External-chain bonds can be slashed if a guardian is proven to ignore valid requests.

### Coordinator / relay censorship

Coordinators and relays are optional. A single coordinator can refuse to forward or broadcast.

**Mitigations:**

- The default mode is **client-as-aggregator**: the client collects partial signatures and broadcasts the final block itself.
- Multiple independent coordinators can operate in parallel; the client uses any that respond.
- Guardians can gossip partial signatures among themselves, so no single coordinator is required for aggregation.
- Partial signatures are bound to the exact Nano block hash, so a relay cannot alter `P_w`.

### Nano RPC / provider censorship

An RPC provider can refuse reads, reject `process` calls, rate-limit, or serve stale data.

**Mitigations:**

- The client uses multiple independent public RPC endpoints with automatic fallback.
- It tracks the last known-good endpoint and retries across endpoints.
- Reads can be cross-checked against multiple providers (quorum consensus).
- Block signatures and previous-hash links are verified locally.
- Clients can compute PoW locally if remote `work_generate` is censored.

### Bootstrap / endpoint discovery censorship

Hardcoded lists can be blocked, Nostr relays can be censored, and on-chain announcements can be spammed.

**Mitigations:**

- Signed endpoint manifests are distributed through multiple channels: hardcoded bootstrap, Nostr relays, IPFS, libp2p DHT, and Nano `RootCommit` anchors.
- Clients require intersection across independent sources and verify signatures before trusting an endpoint.
- Tor/I2P hidden-service addresses are included in manifests for when clearnet is blocked.

### Network / transport censorship

ISPs or governments can block IP addresses, domains, ports, or Tor traffic.

**Mitigations:**

- Guardian and indexer endpoints are exposed over HTTPS, Tor hidden services, and optionally WebSocket.
- Clients attempt multiple transports in parallel and use the first working path.
- Operator locations are hidden by Tor; domain seizure does not affect `.onion` addresses.

### External slashing-contract censorship

A bond custodian set or a majority of guardians could refuse to act on a valid fraud proof, allowing a misbehaving guardian to keep its bond.

**Mitigations:**

- Bond custody uses a Nano multi-sig requiring a high threshold (e.g., 3-of-5 or supermajority) of independent arbiters, not a single party.
- Fraud proofs are published publicly on Nano and Nostr so they cannot be hidden.
- If the bond custodians are unresponsive, clients and guardians fall back to social exclusion (blacklists) and share revocation via re-sharing.

### Summary

No single failure point can permanently censor VELA v2. Deposits need only Nano liveness; withdrawals need only `t` honest guardians and any working RPC path; discovery uses multiple independent channels; transport falls back through Tor and alternate protocols.

---

## 10. Privacy Model

VELA v2 provides **unlinkability**, not transaction invisibility.

### What is hidden

- **Deposit-withdrawal link**: a Groth16 proof shows that a withdrawal is authorized by some valid deposit, but does not reveal which deposit.
- **Recipient identity**: withdrawals use stealth addresses; the recipient's long-term public key is not visible on-chain.
- **Exact amount**: deposits and withdrawals are restricted to a small set of fixed denominations, so many transactions share the same amount.

### What is not hidden

Nano's ledger is fully transparent. The withdrawal transaction itself reveals:

- The one-time recipient address `P_w`.
- The amount being withdrawn.
- The timestamp of confirmation.

An observer can see that a withdrawal happened, but cannot determine which deposit funded it.

### Privacy-enhancing practices

- **Fixed denominations**: the protocol enforces a set of allowed amounts (e.g., 0.1, 1, 10 XNO). This prevents trivial amount-based linking.
- **Stealth addresses**: the client derives a fresh `P_w` for every withdrawal; the recipient scans the chain for outputs to their stealth keys.
- **Timing jitter** (optional): clients may randomize the delay between deposit and withdrawal to weaken temporal correlation.
- **Decoy transactions** (optional): clients may broadcast small unrelated payments near the time of withdrawal to add noise. This costs extra fees and is not relied upon for the core security argument.

### Limitation

No mechanism built on top of the current Nano protocol can hide the recipient or amount of a single transaction. Users who need stronger privacy should accept this limitation or wait for future Nano protocol upgrades.

---

## 11. Economic Security

VELA v2 stays entirely on Nano. Because Nano has no smart contracts, automatic, non-custodial slashing cannot be enforced by the protocol directly. Economic security is therefore achieved through a combination of **bonded multi-sig custody**, **public fraud proofs**, **share revocation via re-sharing**, and **social/economic exclusion**.

### Honest limitation

No mechanism on Nano alone can automatically seize funds from a misbehaving party. All penalties require action by a human supermajority (guardians, arbiters, or the community). The design below makes misbehavior detectable, punishable by a supermajority, and costly in reputation.

### Registration

Before participating, a guardian or indexer registers:

- A Nano account used for protocol actions.
- A URL / Tor onion endpoint.
- (Optional but recommended) A bond held in a Nano multi-sig account controlled by a supermajority of arbiters.

Clients only accept signatures and roots from registered participants. Bonded participants are preferred, but the protocol does not require a bond to function.

### Fraud proofs

Anyone can publish a fraud proof. A valid fraud proof consists of public Nano data plus the relevant ZK proof material:

| Misbehavior | Fraud proof |
|-------------|-------------|
| Guardian signs an invalid or unauthorized withdrawal | The invalid Nano block, the guardian's partial signature or FROST identification, and a proof that the ZK verification or nullifier check failed. |
| Guardian signs a double-spend | Two distinct Nano blocks spending the same nullifier, both with valid signatures from the guardian. |
| Guardian offline beyond timeout | A challenge-response record showing the guardian failed to answer a liveness query. |
| Indexer publishes incorrect root | The claimed root, the on-chain RootCommit transaction, and a Merkle proof that the root does not match the ledger data. |
| Indexer censors a deposit | A challenge showing the indexer omitted a deposit block that appears on Nano. |

Fraud proofs are published to public channels: Nano `RootCommit`-style messages, Nostr, and the protocol's public logs.

### Bond and slashing (pure Nano)

If bonds are used, they are held in a Nano multi-sig account requiring a high threshold (e.g., 3-of-5 or 2/3 supermajority) of independent arbiters. When a fraud proof is accepted:

1. The arbiters verify the proof.
2. If valid, the arbiters sign a Nano transaction to move the bond to a protocol treasury or burn address.
3. A portion of the recovered bond may be paid to the prover as a bounty.

Because this requires human arbiters to sign, it is not automatic. It is the strongest economic deterrent available on Nano.

### Share revocation

For guardians, the most powerful enforcement is cryptographic. A supermajority of honest guardians can:

1. Accept a public fraud proof.
2. Run a re-sharing protocol to generate new FROST shares for the remaining set.
3. Exclude the misbehaving guardian's share, rendering it useless.

This is enforced by the FROST protocol itself and does not require a smart contract.

### Social and economic exclusion

In parallel with the above:

- Clients maintain a local blacklist of keys with proven misbehavior and refuse to use them.
- Indexers and guardians that lose community trust see fewer assignments, creating informal economic pressure.
- Public accountability logs expose non-responsive or misbehaving operators.

These social measures are not automatic, but they make repeated misbehavior unsustainable.

---

## 12. Client Performance

Withdrawing requires a Groth16 proof over a depth-20 Poseidon Merkle tree. In the prototype this is done by calling `snarkjs` through a Node.js bridge because Python 3.14 cannot install a native Poseidon library. The bridge adds process startup and serialization overhead, so the client experience is slower than necessary.

### Performance roadmap

The target is sub-second proof generation on a commodity laptop and a path to browser/wallet proving.

| Phase | Mechanism | Goal |
|-------|-----------|------|
| 1 | **Native Rust/PyO3 prover** | Replace the Node bridge with a compiled Python extension that generates the witness and Groth16 proof in Rust via `arkworks`. This removes the Node dependency and the subprocess overhead. |
| 2 | **Pippenger MSM + fixed-base precomputation** | Replace generic multi-scalar multiplication with Pippenger's algorithm and precomputed window tables for zkey base points, cutting proving time further. |
| 3 | **Circuit constraint minimization** | Reduce R1CS constraints by optimizing Poseidon parameters and Merkle-path hashing. Requires a new trusted-setup artifact and a security review. |
| 4 | **WASM SIMD/threaded prover** | Compile the Rust prover to `wasm32` with SIMD and optional threading for browser and light-wallet clients. |

### What stays the same

- The circuit semantics, public inputs, and verification key remain unchanged in phases 1 and 2.
- Phase 3 changes the circuit and trusted setup, so it is only done after an audit.
- Phase 4 reuses the same Rust core and does not affect the protocol.

### Non-goals

- GPU proving is not required for the CLI.
- Caching final proofs is unsafe because each withdrawal uses a unique nullifier; only setup-dependent subresults may be cached.

---

## 13. Deployment and Operations

### Guardian setup

1. `n` operators each run a guardian instance.
2. Operators perform a DKG ceremony to generate FROST shares and the aggregate pool public key.
3. Each operator backs up its share encrypted at rest.
4. The pool address is derived from the aggregate public key.
5. Guardians expose their signing endpoints via Tor hidden service or public HTTPS.

### Indexer setup

1. Any party runs an indexer connected to one or more Nano RPC endpoints.
2. The indexer needs no key material.
3. Indexers publish roots via API and optionally on-chain.

### Client setup

1. The client needs a list of guardian and indexer endpoints.
2. Endpoints can be discovered via hardcoded bootstrap list, Nostr events, or on-chain announcements.
3. The client generates proofs locally and can act as its own coordinator.

### Web client on Vercel

A production Next.js web client lives in `web/` and is designed to deploy on Vercel:

- **Vercel hosts** the static/dynamic UI and lightweight serverless API routes.
- **Hostinger VPS hosts** the heavy backend: indexer, guardian, coordinator/prover.
- **rpc.nano.to** provides server-side Nano RPC access via `NANO_RPC_KEY`.

Key API routes:

| Route | Purpose |
|-------|---------|
| `GET /api/health` | Vercel + Nano RPC health |
| `GET /api/status` | Pool status from Hostinger backend |
| `GET /api/balance?account=...` | Nano balance via `rpc.nano.to` |
| `POST /api/deposit` | Forward deposit receipt to backend |
| `POST /api/withdraw` | Forward withdrawal proof to backend |
| `POST /api/prove` | Proxy proof generation to backend |

Configuration is via environment variables (see `web/.env.example`):

- `NANO_RPC_ENDPOINT` / `NANO_RPC_KEY`
- `VELA_BACKEND_URL` / `VELA_BACKEND_API_KEY`
- `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` (optional rate limiting)
- `NEXT_PUBLIC_APP_NAME` / `NEXT_PUBLIC_APP_URL`

Security is enforced through:

- Strict HSTS, CSP, frame-options, referrer-policy headers in `web/next.config.ts`.
- Zod input validation on all API routes.
- Optional Upstash Redis rate limiting.
- Server-side-only access to RPC and backend keys.

See `docs/vercel_production_readiness.md` for the full checklist.

---

## 14. BPMN Model

A detailed BPMN 2.0 model of the full protocol is available at:

```
docs/VELA_v2_architecture.bpmn
```

Open it in any BPMN editor (e.g., Camunda Modeler, bpmn.io).

---

## 15. Critical Design Area Analyses

Deep-dive analyses for active protocol-design questions are maintained in `docs/design_analysis/`:

- `docs/design_analysis/pattern_matching_defenses.md` — mitigations against deposit-to-withdrawal pattern matching on Nano's transparent ledger.
- `docs/design_analysis/small_and_big_amounts.md` — supporting arbitrary withdrawal amounts without external smart contracts, using fixed denominations and change rotation.
- `docs/design_analysis/scalability_and_deployment.md` — scaling for operators and users, deployment simplification, and client proving options.

Each document includes ranked mechanisms, rejected ideas, and a recommended composite fix. They are updated as the design evolves.

---

## Appendix: Files and Code

- `src/vela_crypto.py` — Nano addressing, Ed25519-blake2b signing, stealth addresses, Poseidon commitments and nullifiers.
- `src/poseidon_bridge.py` — Python-to-Node bridge for Circom-compatible Poseidon hashing.
- `src/snarkjs_bridge.py` — Python-to-Node bridge for Groth16 proof generation and verification.
- `src/vela_indexer.py` — Indexer service.
- `src/vela_guardian.py` — Guardian service (single-key implementation; threshold FROST in implementation phase).
- `src/vela_client.py` — CLI client for deposits and withdrawals.
- `circuit/vela.circom` — Groth16 withdrawal circuit.
- `docs/VELA_v2_architecture.bpmn` — Full BPMN model.
