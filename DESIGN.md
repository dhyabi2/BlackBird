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
10. [Economic Security](#10-economic-security)
11. [Deployment and Operations](#11-deployment-and-operations)
12. [BPMN Model](#12-bpmn-model)

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

For the prototype, a **trusted dealer** distributes FROST shares to guardians. The dealer is trusted only at setup; it does not participate in signing and is destroyed after distribution. This lets the protocol use `frost-core`'s verifiable share generation and avoids the complexity of a production DKG before the ciphersuite is fully audited.

Periodic **share refresh** is planned and will reuse the same trusted-dealer or a lightweight proactive-refresh ceremony; the design defers the full DKG ceremony until after the Ed25519-blake2b ciphersuite has been independently reviewed.

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

- **Deposits** need only Nano liveness; no indexer or guardian can block them.
- **Roots** are deterministic; a client can compute its own root from public Nano data if all indexers fail.
- **Withdrawals** cannot be blocked by a single guardian because any `t-of-n` subset can sign.
- **Coordinator** is optional and untrusted. The client can aggregate signatures and broadcast itself; any third-party coordinator is only a relay. A coordinator cannot alter `P_w` because partial signatures are bound to the exact Nano block hash.
- **Front-running** is prevented by binding `P_w` into the Groth16 public signals, the withdrawal intent hash, and the FROST-signed block hash.
- **Transport** over Tor hidden services hides operator locations and resists IP-level blocking.

---

## 10. Economic Security

Guardians and indexers are bonded. Misbehavior is slashed:

| Misbehavior | Slashing action |
|-------------|-----------------|
| Guardian signs an invalid or unauthorized withdrawal | Full bond slashed; share revoked. |
| Guardian signs a double-spend | Full bond slashed. |
| Guardian offline beyond timeout | Partial bond slashed; replaced. |
| Indexer publishes incorrect root | Bond slashed; root rejected. |
| Indexer censors a deposit | Bond slashed if challenged. |

Slashing logic can be enforced on a smart-contract chain or via social/economic exclusion until native Nano programmability becomes available.

---

## 11. Deployment and Operations

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

---

## 12. BPMN Model

A detailed BPMN 2.0 model of the full protocol is available at:

```
docs/VELA_v2_architecture.bpmn
```

Open it in any BPMN editor (e.g., Camunda Modeler, bpmn.io).

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
