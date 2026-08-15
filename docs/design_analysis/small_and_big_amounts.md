# Critical Area Analysis: Small and Big Amounts

## Methodology

1. Initial ideas: Methodology-Tree engine (`POST /api/v1/run`, mode=deep).
2. Refinement/ranking: `deepseek/deepseek-v4-flash-0731`.
3. Constraint: **No external smart contracts.** All mechanisms must work on Nano.

## Invalid or weak ideas

| ID | Name | Why rejected |
|----|------|--------------|
| 4 | Peer-to-peer atomic swaps via HTLCs | Nano has no timelocks or hash covenants; true HTLC impossible. |
| 7 | Privacy-preserving ring signatures | Would require Nano hard fork; balances remain public. |
| 8 | Fee subsidy via staking | Nano has no fees; representative staking does not generate subsidy income. |
| 10 | Cross-chain bridge for arbitrage | Unrelated to denominations; introduces bridge trust. |

## Ranked mechanisms

| Rank | Name | Mechanism | Problem solved | Required change | Drawback | Score |
|------|------|-----------|----------------|-----------------|----------|-------|
| 1 | Multi-denomination withdrawals | Allow a withdrawal to prove inclusion in several denomination trees and produce multiple outputs (e.g., 10 + 1 + 0.1). | Arbitrary amounts within fixed denominations. | Circuit/flow supports multiple proofs/outputs per withdrawal. | More proofs/outputs for odd amounts. | 90 |
| 2 | Standard denomination ladder | Use a geometric ladder (e.g., 0.01, 0.1, 1, 10, 100 XNO). | Coverage across small and large values. | Define ladder; clients decompose amounts. | More trees; more circuits if tree root differs per denom. | 88 |
| 3 | Client-side change rotation | Surplus from a fixed-denomination withdrawal goes to a fresh user-controlled address. | Exact change without address reuse. | HD wallet + change derivation. | More accounts to scan. | 85 |
| 4 | Single mixed pool with amount hidden? | Not possible on Nano; amounts are public. Documented as a limitation. | — | — | — | N/A |
| 5 | Minimum viable micro-denomination | Lowest denomination set just above dust/PoW cost threshold. | Very small withdrawals remain practical. | Choose minimum denom carefully. | Too low = uneconomical; too high = excludes small users. | 80 |
| 6 | Flat protocol fee with floor/cap | Fee is flat in raw but capped as a percentage for large withdrawals. | Small withdrawals not priced out; large withdrawals not overcharged. | Guardian fee policy. | Fee visible on-chain; may still leak coarse amount. | 75 |
| 7 | Scheduled batch windows | Collect small withdrawals and release in batches. | Reduces per-withdrawal overhead. | Scheduler; delayed finality. | Latency; anti-gaming rules. | 72 |
| 8 | Dust vaults | Tiny balances accumulate and are rebalanced when threshold is reached. | Micro-withdrawals economical. | Dust account management. | Wait time; accounting complexity. | 68 |
| 9 | Tiered pool accounts | Pool maintains separate accounts per denomination tier. | Liquidity organization. | Multiple pool accounts. | Rebalancing complexity. | 65 |
| 10 | Pool-issued work vouchers | Pool signs and broadcasts small blocks to avoid high PoW on low-balance accounts. | Disproportionate PoW cost for small accounts. | Pool signs user destination blocks. | Centralizes send capability. | 60 |

## Composite fix (selected)

**Combination:** Standard denomination ladder + multi-denomination withdrawals + client-side change rotation + minimum viable micro-denomination + flat fee with floor/cap.

**Description:** Define a ladder of fixed denominations (e.g., 0.01, 0.1, 1, 10, 100 XNO). A withdrawal of any amount is decomposed into a minimal set of denominations; the client generates one ZK proof per denomination used and the guardian signs the corresponding outputs. Any surplus is sent to a fresh change address. The minimum denomination is set just above the dust/PoW cost threshold. The protocol fee is flat but capped as a percentage of large withdrawals so small withdrawals remain viable.

**Score:** 90/100

## Honest limitation

Nano amounts are public. VELA cannot hide the withdrawal amount, only the deposit-withdrawal link. The denomination scheme is a privacy/usability trade-off, not true amount hiding.

## No external smart contracts

All mechanisms are client-side, guardian-policy, or protocol-convention changes. No smart contracts are used.
