# Critical Area Analysis: Coordinator / Relay Censorship

## Methodology

1. Initial ideas: Methodology-Tree engine (`POST /api/v1/run`, mode=deep).
2. Refinement/ranking: `deepseek/deepseek-v4-flash-0731`.

## Invalid or weak ideas

| ID | Name | Why rejected |
|----|------|--------------|
| 6 | Public key verification | Authentication, not censorship resistance. |
| 7 | Block hash anchoring | Nano has no smart contracts; anchoring does not enforce liveness. |
| 10 | Community node incentives | No enforceable incentives on Nano; social only. |

## Ranked mechanisms

| Rank | Name | Mechanism | Threat | Required change | Drawback | Score |
|------|------|-----------|--------|-----------------|----------|-------|
| 1 | Client-side aggregation | Client collects partial signatures and aggregates/broadcasts the final block itself. | Coordinator refusing to broadcast or returning invalid aggregate. | Client runs FROST aggregation; public keys published. | Client must be online and capable. | 95 |
| 2 | Direct guardian contact | Client sends withdrawal requests directly to guardians, bypassing coordinator. | Coordinator refusing to forward. | Guardian endpoint discovery in client. | Client needs guardian list. | 93 |
| 3 | Multiple redundant coordinators | Several independent coordinators/relays operate; clients use any that respond. | Single coordinator censorship. | Coordinator list + failover logic. | Bandwidth multiplied; may collocate. | 85 |
| 4 | Asynchronous threshold completion | t-of-n signing means client accepts any t valid partials; no need to wait for all n. | Coordinator withholding some partial signatures. | Already in FROST design. | Choosing t is a trade-off. | 88 |
| 5 | Guardian-to-guardian gossip | Guardians gossip partial signatures among themselves; any guardian can aggregate. | Coordinator as sole aggregation point. | Gossip protocol + peer discovery. | O(n²) messages; NAT traversal. | 75 |
| 6 | Multi-path redundant delivery | Partial signatures sent over direct + relay paths; deduplication at receivers. | Relay dropping messages. | Path redundancy + dedup cache. | Higher latency/bandwidth. | 70 |
| 7 | Watchtower aggregators | Independent nodes monitor and aggregate/broadcast if coordinators stall. | Coordinator refusing to broadcast. | Watchtower network. | Extra infrastructure. | 68 |
| 8 | Signed delivery receipts | Relays sign receipts for forwarded partials; clients detect withholding. | Silent withholding. | Receipt signing and audit. | Overhead; colluding relays can fake receipts. | 60 |
| 9 | Fallback relay rotation | Deterministic rotation to next relay on timeout. | Coordinator failure. | Timeout + ordered list. | Slow; hostile relay may be next. | 55 |
| 10 | Network-agnostic propagation | Use multiple transports (Tor, WebSocket, IPFS). | Network-level blocking. | Multi-transport adapters. | Complexity; all transports can still be blocked. | 50 |

## Composite fix (selected)

**Combination:** Client-side aggregation + direct guardian contact + multiple redundant coordinators + asynchronous threshold completion + gossip mesh as future hardening.

**Description:** The coordinator is reduced to an optional accelerator. The client can always contact guardians directly, collect any t partial signatures, aggregate locally, and broadcast. Multiple coordinators provide redundancy. Guardians gossip partial signatures so that no single coordinator is a bottleneck. This eliminates coordinator censorship without adding trusted parties.

**Score:** 95/100

## Author's note

Most of this composite fix is already in VELA v2 (client-as-aggregator, direct guardian contact, parallel coordinators). Guardian-to-guardian gossip is documented as future hardening.
