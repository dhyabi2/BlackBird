# Critical Area Analysis: Privacy Leaks (Withdrawal Recipient / Amount Public)

## Methodology

1. Initial ideas: Methodology-Tree engine (`POST /api/v1/run`, mode=deep).
2. Refinement/ranking: `deepseek/deepseek-v4-flash-0731`.

## Note on the model ranking

The refinement model rejected **fixed denominations**, arguing that exact amounts reveal links. This is incorrect for a pool-based mixer: fixed denominations reduce amount correlation because every withdrawal looks the same size. I have kept fixed denominations as a core mechanism in the final recommendation.

## Invalid or weak ideas

| ID | Name | Why rejected |
|----|------|--------------|
| 5 | Self-mixing loops | Adds hops but the chain is still public and followable by graph analysis; adds fees. |
| 6 | Proof aggregation | Would require a major protocol change and is incompatible with Nano's account-chain model. |
| 7 | Cross-pool shuffling | Requires an external coordinator or smart contract; trust and sybil issues. |
| 8 | Sybil resistance via staking for decoys | Only improves decoy quality; does not hide the real transaction. |
| 9 | Public ledger acknowledgment | Counterproductive; increases transparency. |

## Ranked mechanisms

| Rank | Name | Mechanism | Privacy property | Required change | Drawback | Score |
|------|------|-----------|------------------|-----------------|----------|-------|
| 1 | Fixed denominations | Deposits and withdrawals use a small set of fixed amounts (e.g., 0.1, 1, 10 XNO). | Amount unlinkability: many withdrawals share the same amount, making value-based correlation harder. | Enforce denomination set in the circuit and guardian validation. | Capital inefficiency; users may need multiple withdrawals. | 90 |
| 2 | Stealth address rotation | Each withdrawal uses a fresh one-time address derived via ECDH from the recipient's public key. | Recipient unlinkability: observers cannot link multiple withdrawals to the same receiver. | Already in VELA v2; clients must scan for stealth outputs. | Scanning overhead; sender-recipient link still visible in one transaction. | 85 |
| 3 | Timing jitter | Clients randomize the delay between deposit confirmation and withdrawal request. | Temporal correlation resistance. | Client-side delay logic. | Adds latency; statistical attacks still possible over many observations. | 65 |
| 4 | Decoy transaction injection | Clients optionally broadcast small decoy payments around the same time as the real withdrawal. | Anonymity-set expansion / plausible deniability. | Client-side decoy generation. | Extra fees and network load; poorly constructed decoys can be filtered. | 55 |
| 5 | Volume capping | Cap maximum deposit/withdrawal size to avoid whale identification. | Prevents trivial identification of large participants. | Guardian/indexer policy. | Limits utility; not a strong privacy guarantee. | 50 |

## Honest limitation

Nano's ledger is fully transparent. **VELA cannot hide the withdrawal transaction itself**: the recipient address `P_w` and the amount are visible on-chain. VELA's privacy guarantee is **unlinkability** — an observer cannot determine which deposit funded which withdrawal — not **invisibility** of the withdrawal.

## Composite fix (selected)

**Combination:** Fixed denominations + stealth address rotation + optional timing jitter + optional decoy injection + explicit privacy-model documentation.

**Description:** Use fixed denominations to reduce amount correlation, stealth addresses to hide recipient identity, and optional client-side timing jitter/decoys to add noise. Document clearly that Nano limits privacy to unlinkability.

**Score:** 88/100
