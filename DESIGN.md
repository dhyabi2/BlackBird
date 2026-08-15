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
2. **On-chain (optional)**: indexers publish root blocks on Nano for censorship-resistant availability.

### Client validation

A client should query multiple independent indexers and accept a root only if a majority agree. Roots are deterministic, so any divergence indicates a faulty or malicious indexer.

---

## 7. Guardian Network

The guardian network is a `t-of-n` FROST threshold signer set. The pool public key is the aggregate FROST public key; no single guardian knows the full private key.

### Responsibilities of each guardian

- Verify Groth16 proofs against accepted roots.
- Check that the nullifier is not already spent.
- Contribute a partial Ed25519-blake2b signature to a withdrawal block if and only if the proof and nullifier checks pass.

### FROST ciphersuite

Because Nano uses Ed25519-blake2b, the FROST implementation must use Blake2b for all internal hashes (nonce derivation, challenge computation). Standard Ed25519-SHA512 FROST libraries are incompatible with Nano.

### Network communication

Guardians expose their partial-signature endpoints as public HTTPS or Tor hidden services. They authenticate requests with their FROST public shares. No private network is required.

### Coordinator

The coordinator:

- Sends the same withdrawal request to at least `t` guardians.
- Collects partial signatures.
- Aggregates them into a full Ed25519-blake2b signature.
- Attaches the signature to the withdrawal block and broadcasts it.

The coordinator is untrusted. It cannot produce a valid signature without `t` guardians, and it cannot forge a withdrawal because each guardian verifies the proof independently.

---

## 8. Withdrawal Flow

1. The client reads the accepted Merkle root for the deposit's epoch and denomination.
2. The client fetches the inclusion proof for its commitment `C`.
3. The client generates a Groth16 proof with public inputs `(root, nullifier, P_w_lo, P_w_hi)` and private inputs `(n, t, S_pub, path, leafIndex)`.
4. The client sends the withdrawal request `(proof, publicSignals, P_w, epoch, denomination)` to at least `t` guardians (directly or via a coordinator).
5. Each guardian verifies:
   - the Groth16 proof;
   - that the root is accepted;
   - that the nullifier is unspent;
   - that `P_w` matches the public signals.
6. Each honest guardian returns a partial signature over the withdrawal block hash.
7. The coordinator aggregates `t` partial signatures into the final signature.
8. The coordinator broadcasts the signed withdrawal block to Nano.
9. Nano confirms the withdrawal; the nullifier is now spent.

---

## 9. Censorship Resistance

- **Deposits** need only Nano liveness; no indexer or guardian can block them.
- **Roots** are deterministic; a client can compute its own root from public Nano data if all indexers fail.
- **Withdrawals** cannot be blocked by a single guardian because any `t-of-n` subset can sign.
- **Coordinator** can be any party, including the withdrawer. There is no mandatory coordinator.
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
