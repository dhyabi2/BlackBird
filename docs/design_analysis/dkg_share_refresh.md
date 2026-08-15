# Critical Area Analysis: DKG and Share Refresh

## Methodology

1. Initial ideas: Methodology-Tree engine (`POST /api/v1/run`, mode=deep).
2. Refinement/ranking: `deepseek/deepseek-v4-flash-0731`.

## Invalid or weak ideas

| ID | Name | Why rejected |
|----|------|--------------|
| 5 | Threshold encryption for share distribution | Not needed for FROST keygen; FROST already uses Shamir sharing. Adds complexity without solving the core DKG problem. |
| 6 | Deterministic seed derivation for offline guardians | Predictable key material; if seed is compromised all shares are lost. FROST requires proper randomness. |
| 9 | Blind signature integration for anonymity | Blind signatures are irrelevant to FROST keygen/resharing and add unnecessary cryptographic complexity. |

## Ranked mechanisms

| Rank | Name | Mechanism | Required change | Assumption | Drawback | Score |
|------|------|-----------|-----------------|------------|----------|-------|
| 1 | Asynchronous Feldman VSS DKG | Each participant acts as a dealer using Feldman VSS; final group key is the sum of contributions. | Replace trusted dealer with distributed keygen in the guardian setup. | At most `t-1` malicious participants; reliable broadcast. | Multiple communication/verification rounds; higher latency. | 92 |
| 2 | Proactive additive share refresh | Periodically add random zero-constant-term polynomials to existing shares; public key unchanged. | Add scheduled refresh protocol after keygen. | Participants are available during refresh; secure channels. | Extra rounds; incorrect implementation can leak old shares. | 88 |
| 3 | Silent non-interactive commitment | Participants post hash commitments to coefficients before revealing them. | Use hash commitments (Blake2b) and a public bulletin board for DKG rounds. | Secure hash; robust dispute handling. | Needs fallback if a party refuses to open. | 85 |
| 4 | Hybrid dealer-to-DKG transition | Trusted dealer generates initial shares; subsequent refreshes/membership changes use DKG. | Keep trusted dealer only for initial prototype launch. | Dealer secret is destroyed after setup. | Dealer compromise at inception risks the whole key. | 82 |
| 5 | Dynamic membership via re-sharing | Existing guardians jointly generate new shares for a changed set without changing the group key. | Implement re-sharing protocol for join/leave events. | Threshold unchanged; existing guardians online and cooperative. | Complex coordination; must invalidate old shares. | 80 |
| 6 | Interactive proof verification for liveness | Schnorr-style proofs in each DKG/refresh round to verify liveness. | Add liveness challenges to protocol rounds. | Synchronous enough for timeouts; reliable network. | More rounds; DoS risk from slow nodes. | 78 |
| 7 | Multi-path redundancy for gossip | Gossip-based broadcast with redundant paths for DKG messages. | Replace point-to-point DKG transport with gossip layer. | Partially connected network; eventual delivery. | More messages; duplicate handling needed. | 75 |

## Composite fix (selected)

**Combination:** Asynchronous Feldman VSS DKG + Silent non-interactive commitment + Proactive additive share refresh + Dynamic membership re-sharing.

**Description:** Use asynchronous Feldman VSS DKG for initial key generation, eliminating the trusted dealer. Reduce communication rounds with silent hash commitments posted to a public bulletin board. Run proactive additive share refresh periodically to invalidate old shares. Use a re-sharing protocol for guardian join/leave while keeping the same group public key.

**Score:** 93/100
