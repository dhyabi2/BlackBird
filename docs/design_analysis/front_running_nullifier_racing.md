# Critical Area Analysis: Front-Running / Nullifier Racing

## Methodology

1. Initial ideas: Methodology-Tree engine (`POST /api/v1/run`, mode=deep).
2. Refinement/ranking: `deepseek/deepseek-v4-flash-0731`.

## Note on the model ranking

The refinement model frequently assumed smart-contract enforcement (nullifier registry, slashing, timelock queue). Because Nano has no smart contracts, those mechanisms must be implemented via guardian policy, external-chain bonds, and Nano's own confirmation ordering. The final recommendation adapts the valid ideas to Nano's constraints.

## Invalid or weak ideas

| ID | Name | Why rejected |
|----|------|--------------|
| 1 | Client-side sequential nonce | Not enforceable by the network; a malicious client can reuse nonces. |
| 4 | Deposit bonding | Adds user friction; Nano cannot enforce bonds natively. |
| 5 | Deterministic client ordering | No global order on Nano; gameable without a trusted coordinator. |
| 6 | Out-of-band intent signing | Adds UX complexity; does not stop a malicious coordinator. |
| 7 | Pre-signed withdrawal batches | Allows replay and delay; no on-chain invalidation. |
| 8 | Asynchronous off-chain nullifier registry | Not tamper-proof; a coordinator can ignore it. |
| 9 | ZK proof of nonce validity | Overhead without solving ordering/front-running. |

## Ranked mechanisms (adapted for Nano)

| Rank | Name | Mechanism | Threat addressed | Required change | Drawback | Score |
|------|------|-----------|------------------|-----------------|----------|-------|
| 1 | Bind P_w into the signed message | Guardians sign the exact Nano block hash that includes `P_w`; changing `P_w` invalidates all partial signatures. | Coordinator front-running / address substitution. | Already in PR #2: withdrawal intent hash + FROST message binding. | None significant. | 95 |
| 2 | Nullifier set check before signing | Each guardian maintains a set of spent nullifiers and refuses to sign if the nullifier is already spent or already being signed. | Double-spending / nullifier racing. | Guardian state + check in `verify_withdrawal_request`. | Requires guardians to sync or accept eventual consistency. | 90 |
| 3 | First-confirmed-wins on Nano | Multiple valid withdrawals with the same nullifier race; Nano's Open Representative Voting confirms one first; later ones are rejected by guardians. | Nullifier racing. | Document behavior; no code change. | Temporary forks possible; user sees one confirm. | 85 |
| 4 | Commitment-reveal for withdrawal intent | Client publishes `H(P_w, amount, nullifier, nonce)` before collecting signatures; guardians verify the reveal matches. | Coordinator front-running. | Add intent-commitment step (already partially in PR #2). | Adds one round of communication. | 80 |
| 5 | External-chain slashing for double-signing | If two conflicting signed withdrawals are published, fraud proofs slash the double-signing guardian's bond on the external chain. | Colluding guardians. | Already in PR #3: fraud-proof table. | Not real-time; requires monitoring. | 78 |
| 6 | Withdrawal delay / challenge window | Withdrawals are not considered final until a short delay; anyone can submit a fraud proof to guardians during the window. | Coordinator front-running and double-signing. | Add delay logic and fraud-proof broadcast. | Adds latency. | 70 |
| 7 | Guardian-signed audit trail | Guardians publish logs of signed withdrawal intents; misbehavior is detectable post-hoc. | Coordinator/guardian misbehavior. | Logging endpoint. | Not preventive. | 60 |
| 8 | Rate limiting per nullifier | Guardians limit the number of withdrawals they sign for a given nullifier within a time window. | Mitigates double-signing impact. | Guardian policy. | Does not prevent root cause. | 50 |

## Composite fix (selected)

**Combination:** Bind P_w into signed message + nullifier set check + first-confirmed-wins + external-chain slashing + optional withdrawal delay.

**Description:** Prevent coordinator front-running by binding `P_w` into the FROST-signed Nano block. Prevent nullifier racing by having guardians check the nullifier before signing and by relying on Nano's consensus to confirm one valid withdrawal first. Deter colluding guardians via external-chain slashing for double-signing. Add an optional challenge window as a soft fallback.

**Score:** 93/100
