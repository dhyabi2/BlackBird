# Critical Area Analysis: Guardian Censorship

## Methodology

1. Initial ideas: Methodology-Tree engine (`POST /api/v1/run`, mode=deep).
2. Refinement/ranking: `deepseek/deepseek-v4-flash-0731`.

## Note on the model ranking

The refinement model over-rejected transparency-based mechanisms as "no enforcement." On a chain without smart contracts, transparency creates social/economic pressure and is a legitimate mitigation. It also proposed an "atomic swap exit route," which is not applicable to VELA because VELA is a pooled asset, not a transferable token.

## Invalid or weak ideas

| ID | Name | Why rejected |
|----|------|--------------|
| 2 | Censorship bond refundable on completion | Requires smart contracts; not enforceable on Nano. |
| 4 | Staking with multi-sig slash | Requires smart contracts for automatic slashing. |
| 6 | ZK proofs of signing latency | High complexity with no enforcement benefit. |
| 9 | Atomic swap exit route | VELA is a pool, not a token; no DEX exit exists. |
| 10 | Time-locked withdrawal with fallback key | Introduces a backdoor that weakens the threshold security model. |

## Ranked mechanisms (adapted for Nano)

| Rank | Name | Mechanism | Threat | Required change | Drawback | Score |
|------|------|-----------|--------|-----------------|----------|-------|
| 1 | t-of-n threshold with direct client access | Any `t` honest guardians can sign; clients contact guardians directly. | Single-guardian or minority censorship. | Already in VELA v2; ensure large enough `n`. | If `>= n-t+1` collude, censorship succeeds. | 95 |
| 2 | Large, diverse guardian set | Increase `n` and choose operators across jurisdictions/networks. | Censorship by a small coalition. | Governance/provisioning. | Higher coordination cost. | 85 |
| 3 | Public accountability log | Guardians publish partial-signature responses (or non-response proofs) to a public log. | Hidden blacklisting / delays. | Logging endpoint + client audit tooling. | Does not force signing; privacy trade-off. | 80 |
| 4 | Pure-Nano multi-sig bond slashing | Bond held in Nano multi-sig controlled by arbiters; fraud proof triggers arbiter-signed slash transaction. | Long-term censorship. | Multi-sig bond account + arbiter process. | Requires honest arbiters; not automatic. | 70 |
| 5 | Guardian rotation / removal | Underperforming guardians are voted out and replaced via re-sharing. | Persistent malicious minority. | Re-sharing protocol + governance. | Off-chain coordination; slow. | 70 |
| 6 | Multi-pool redundancy | Multiple independent VELA pools; users can deposit into any pool. | Censorship by one pool's guardians. | Deploy multiple pools. | Fragmented liquidity. | 65 |
| 7 | Watchtower service | Third-party monitors guardian response times and publishes alerts/proofs. | Undetected censorship. | Watchtower operator. | Trusted watchtower; false positives. | 60 |
| 8 | Timeout-based fallback signing | Reduce effective threshold if some guardians time out. | Short-term delays. | Dynamic threshold logic. | Reduces security if overused. | 50 |
| 9 | Insurance fund | Compensate users if censored. | Financial loss. | Fund + multi-sig. | Does not prevent censorship; trust assumption. | 40 |

## Composite fix (selected)

**Combination:** t-of-n threshold + large diverse set + public accountability log + pure-Nano multi-sig bond + share revocation via re-sharing + guardian rotation.

**Description:** Make censorship require `>= n-t+1` colluding guardians by using a large, geographically/jurisdictionally diverse set. Give clients direct access so no coordinator can block them. Add public accountability logs to expose misbehavior. Use a Nano multi-sig bond (arbiter-controlled) to impose economic cost, and use FROST re-sharing to cryptographically revoke a misbehaving guardian's share. Rotate persistently unresponsive guardians.

**Score:** 93/100

## No external smart contracts

All enforcement stays on Nano: multi-sig bond movement by arbiters, share revocation by re-sharing, and social exclusion by clients.
