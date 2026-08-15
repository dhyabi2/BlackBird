# Critical Area Analysis: Indexer Censorship

## Methodology

1. Initial ideas: Methodology-Tree engine (`POST /api/v1/run`, mode=deep).
2. Refinement/ranking: `deepseek/deepseek-v4-flash-0731`.

## Invalid or weak ideas

| ID | Name | Why rejected |
|----|------|--------------|
| 4 | Staked indexer slashing | Nano has no smart contracts; on-chain slashing cannot be enforced permissionlessly. |
| 8 | Light client optimization | Performance improvement, not a censorship countermeasure. |
| 10 | Hybrid trust model | Too vague; needs concrete components. |

## Ranked mechanisms

| Rank | Name | Mechanism | Threat | Required change | Drawback | Score |
|------|------|-----------|--------|-----------------|----------|-------|
| 1 | Multi-indexer consensus with gossip | Clients query multiple independent indexers and compare Merkle roots; gossip disseminates roots. | Single-indexer censorship or wrong roots. | Client queries N indexers; indexer gossip layer. | Needs multiple indexers; latency. | 90 |
| 2 | Merkle proof verification | Clients verify inclusion proofs against a known root. | Invalid proofs or proof refusal. | Client-side verification. | Root must be correct first. | 85 |
| 3 | Cross-chain anchoring | Anchor Merkle roots to Ethereum for tamper-evident timestamping. | False-root collusion. | Indexers submit roots to anchor contract. | Cost, latency, external-chain dependency. | 80 |
| 4 | IPFS/DHT proof availability | Store proofs on IPFS/DHT for retrievability. | Indexer refuses proofs or goes offline. | Indexers publish proofs to IPFS. | Probabilistic availability; pinning needed. | 75 |
| 5 | Public audit bounties | Rewards for detecting root-ledger discrepancies. | Wrong roots without detection. | Bounty fund + challenge procedures. | Reactive; no enforcement. | 70 |
| 6 | Reputation system | Track indexer reliability historically. | Long-term misbehavior. | Client selection algorithm. | Gameable; cold-start for new indexers. | 65 |
| 7 | Random sampling | Clients randomly sample indexers. | Targeted client censorship. | Random selection in client. | Probabilistic; exploitable patterns. | 60 |
| 8 | Threshold signatures | M-of-N indexers sign a root. | Single indexer compromise. | Threshold scheme among indexers. | Complex; M collusion still possible. | 55 |
| 9 | Gossip protocol broadcasting | Indexers gossip roots/updates. | Network partition / withholding. | Gossip network. | Overhead; Sybil; doesn't prevent false roots. | 50 |
| 10 | Fraud proofs on anchor chain | Smart-contract fraud proofs for invalid Merkle proofs. | Invalid proofs passing client checks. | Cross-chain fraud-proof contract. | Gas costs; external-chain dependency. | 45 |

## Composite fix (selected)

**Combination:** Multi-indexer consensus + Merkle proof verification + cross-chain anchoring + IPFS proof availability + public audit bounties.

**Description:** Clients query multiple indexers and cross-check roots, then verify proofs locally. Roots are anchored to a secondary chain for tamper evidence. Proofs are replicated to IPFS for availability. Bounties incentivize detection of discrepancies.

**Score:** 92/100

## Author's note

Several of these ideas are already partially in VELA v2 (multi-indexer consensus, `RootCommit`, client verification). The remaining gaps are IPFS proof mirroring and cross-chain anchoring, which are documented as future hardening.
