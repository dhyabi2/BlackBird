# Critical Area Analysis: RPC / Provider Censorship

## Methodology

1. Initial ideas: Methodology-Tree engine (`POST /api/v1/run`, mode=deep).
2. Refinement/ranking: `deepseek/deepseek-v4-flash-0731`.

## Invalid or weak ideas

| ID | Name | Why rejected |
|----|------|--------------|
| 4 | Community-driven node blacklist | Creates a new trust list and censorship vector; gameable. |
| 9 | IP rotation | Only evades rate-limiting; does not address censorship or data integrity; violates provider ToS. |

## Ranked mechanisms

| Rank | Name | Mechanism | Threat | Required change | Drawback | Score |
|------|------|-----------|--------|-----------------|----------|-------|
| 1 | Multi-source quorum consensus | Query multiple RPC providers and require M-of-N agreement on frontier/balance/confirmation. | Provider censorship, stale/wrong data. | Client-side quorum aggregation. | Higher latency; colluding majority can still lie. | 90 |
| 2 | Explicit broadcast fallback chain | Ordered list of providers; try next if broadcast is rejected or times out. | Provider rejects `process`. | Broadcast manager with retry/fallback. | Fails if all providers hostile. | 85 |
| 3 | Hybrid read/write splitting | Separate provider pools for reads vs writes/broadcasts. | Inconsistent provider policies. | Two connection pools + health policies. | More endpoints; complexity. | 82 |
| 4 | Consensus-based block validation | Locally verify signatures, previous-hash links, balance arithmetic; require provider agreement on state. | Forged or malformed blocks. | Local block verifier + confirmation threshold. | Heuristic without full node. | 78 |
| 5 | Dynamic health-aware rotation | Score providers by latency/error/staleness; route to healthiest. | Rate-limiting, degraded providers. | Health tracker + scoring engine. | Health signals manipulable. | 75 |
| 6 | Periodic snapshot verification | Compare provider frontiers against trusted hash source. | Long-term stale/wrong state. | Snapshot verifier. | Trusted source becomes new trust point. | 72 |
| 7 | Redundant indexer queries | Query multiple indexers, cross-validate, fall back to node RPC. | Indexer errors/omissions. | Redundant query layer. | Indexers may share upstream. | 68 |
| 8 | Local block signature verification | Verify Ed25519 signatures and links locally. | Forged block data. | Client-side crypto verification. | Cannot detect withheld blocks. | 65 |
| 9 | Confirmation polling with threshold | Poll multiple providers for confirmation; require threshold agreement. | Stale confirmations. | Confirmation poller. | Slower UX; lag variance. | 62 |
| 10 | In-memory cache with TTL | Short-TTL cache for frequent reads. | Rate-limiting, latency. | Cache layer. | Can serve stale data. | 55 |

## Composite fix (selected)

**Combination:** Multi-source quorum consensus + explicit broadcast fallback chain + hybrid read/write splitting + dynamic health-aware rotation + local block verification + confirmation polling threshold + short-TTL cache.

**Description:** Use multiple independent RPC providers, require M-of-N agreement for critical reads, verify block signatures and links locally, broadcast through an ordered fallback chain, confirm via quorum polling, split read/write pools, rotate to healthy providers, and cache short-lived reads.

**Score:** 93/100

## Author's note

VELA v2's `NanoRPC` already implements multiple fallback endpoints, timeout, retries, and last-good-endpoint tracking. The next improvements are: M-of-N read quorum, local block verification, and separate read/write pools.
