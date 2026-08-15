# Critical Area Analysis: Pattern Matching

## Methodology

1. Initial ideas: Methodology-Tree engine (`POST /api/v1/run`, mode=deep).
2. Refinement/ranking: `deepseek/deepseek-v4-flash-0731`.
3. Constraint: **No external smart contracts.** All mechanisms must work on Nano or via client behavior.

## Invalid or weak ideas

| ID | Name | Why rejected |
|----|------|--------------|
| 1 | FROST key sharding with threshold recovery | FROST improves key security but does not hide on-chain patterns. |
| 6 | Atomic multi-output transactions | Nano send blocks have a single destination; no atomic multi-output. |
| 9 | ZK proof integration | Nano ledger is transparent; off-chain ZK cannot hide on-chain amounts/links. |
| 10 | Representative vote obfuscation | Voting metadata is public and does not hide transaction patterns. |

## Ranked mechanisms

| Rank | Name | Mechanism | Pattern countered | Required change | Drawback | Score |
|------|------|-----------|-------------------|-----------------|----------|-------|
| 1 | Dynamic stealth address derivation | Recipient publishes master key; sender derives fresh one-time account via ECDH. | Address reuse, recipient clustering. | Stealth derivation + scanning in wallet. | Sender account still visible if known. | 92 |
| 2 | Decoy transaction injection | Wallet creates self-transfers and dummy payments at random times. | Graph analysis, timing/amount correlation. | Decoy scheduler + dummy accounts. | Self-cycles detectable; ledger bloat; PoW cost. | 82 |
| 3 | Epoch-based batching with stochastic timing | Queue outgoing payments; release at randomized times within fixed windows. | Event-triggered timing, network observation. | Wallet queue + scheduler. | Delayed finality; fan-out patterns. | 78 |
| 4 | Delayed receive randomization | Recipient waits random interval before issuing receive block. | Send-receive temporal link. | Auto-receive delay logic. | Funds appear unavailable during delay. | 74 |
| 5 | Fixed denomination rounding | External payments rounded to standard denominations; internal change accounts manage exact amounts. | Amount fingerprinting. | Wallet denomination handling. | Denominations themselves become coarse pattern. | 72 |
| 6 | Multi-hop churn | Send through ephemeral intermediate accounts before final destination. | Direct sender-recipient link. | Ephemeral accounts + sequential sends. | Non-atomic; graph analysis may still trace. | 70 |
| 7 | Network-level proxying | Route connections through Tor/I2P/VPN with random egress. | IP metadata, ISP surveillance. | Proxy/VPN/Tor support. | Latency; malicious exits; on-chain data unchanged. | 68 |
| 8 | Balance splitting / no consolidation | Distribute funds across accounts; never merge. | Clustering via balance aggregation. | Multi-account pool management. | More accounts; PoW overhead. | 66 |
| 9 | Pre-generated one-time address pool | Wallet pre-generates addresses and precomputes PoW. | Address reuse, creation-time correlation. | Background address generation. | Storage overhead; pool exhaustion. | 64 |
| 10 | Public RPC / broadcast anonymization | Submit blocks through public RPC or third-party broadcaster; rotate endpoints. | IP origin metadata. | Broadcast via public RPC. | Public nodes may log; trust assumptions. | 60 |

## Composite fix (selected)

**Combination:** Dynamic stealth addresses + fixed denomination rounding + epoch-based stochastic batching + delayed receive randomization + decoy injection + network proxying.

**Description:** Use stealth addresses by default so recipients have no static address. Round all external payments to fixed denominations and manage change internally. Queue withdrawals and release them at randomized times within epochs. Delay receive blocks randomly. Inject decoy self-payments for noise. Route all traffic through Tor/VPN/proxies. This layers protections across address, amount, time, graph, and network dimensions.

**Score:** 91/100

## No external smart contracts

All pattern-matching mitigations are client-side, network-layer, or protocol-convention changes. No smart contracts are used.
