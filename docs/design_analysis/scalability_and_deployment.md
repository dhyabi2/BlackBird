# Critical Area Analysis: Scalability and Deployment

## Methodology

1. Initial ideas: Methodology-Tree engine (`POST /api/v1/run`, mode=deep).
2. Refinement/ranking: `deepseek/deepseek-v4-flash-0731`.
3. Constraint: **No external smart contracts.** All mechanisms must work on Nano.

## Invalid or weak ideas

| ID | Name | Why rejected |
|----|------|--------------|
| 1 | Centralized cloud coordinator | Introduces a single point of failure and contradicts VELA's censorship-resistance goals. |
| 7 | P2P gossip for indexer consensus | More complex and inconsistent than deterministic on-chain `RootCommit` consensus. |
| 11 | Guardians as Tor hidden services only | Adds operational/legal friction; Tor can be optional but not exclusive. |
| 14 | Subsidy from protocol treasury | Not a technical scalability/deployment mechanism and Nano has no native treasury. |

## Ranked mechanisms

| Rank | Name | Mechanism | Problem solved | Required change | Drawback | Score |
|------|------|-----------|----------------|-----------------|----------|-------|
| 1 | Docker Compose all-in-one | Package guardian, indexer, client, and bridges in a single `docker-compose.yml` with one-command startup. | Eliminates manual dependency setup. | Add Dockerfile(s) and compose manifest. | Requires Docker; resource overhead. | 90 |
| 2 | WASM client prover | Compile Rust/PyO3 prover to WASM for browser/edge clients. | Offloads proof generation from servers. | Build WASM target; JS bindings. | Browser performance and bundle size. | 85 |
| 3 | On-chain compressed state commitments | Indexers anchor a compact `RootCommit` on Nano instead of posting full state. | Reduces on-chain footprint. | Define commitment format and aggregation. | Off-chain state availability required. | 80 |
| 4 | GitHub binary releases | Precompiled signed binaries for major platforms. | Easier user/operator onboarding. | CI build/release pipeline. | Supply-chain trust concerns. | 75 |
| 5 | Automated deployment scripts | Ansible/Terraform playbooks for VPS/cloud. | Reproducible operator deployments. | Maintain scripts per environment. | Overkill for small operators. | 70 |
| 6 | Lightweight verification mode | Client verifies only block headers and guardian signatures, skipping full ZK verification. | Reduces sync time on low-end devices. | Optional verification levels. | Reduced security for high-value withdrawals. | 65 |
| 7 | Client-side batch operations | Combine multiple deposits/withdrawals into a single proof. | Reduces proof and on-chain count. | Batch circuit and flow. | Longer proof generation; UX complexity. | 60 |
| 8 | Remote proving service | Server generates proofs for clients using blinded inputs. | Helps low-power clients. | Service endpoint with blinding. | Trust and privacy risks. | 55 |
| 9 | Preloaded circuit artifacts | Distribute proving/verification keys as downloadable static files. | Faster first startup. | Secure artifact hosting. | Stale params risk. | 50 |
| 10 | Auto-config wizard | Interactive CLI/web wizard generates operator/client configs. | Lowers setup barrier. | Wizard implementation. | May not cover edge cases. | 45 |

## Composite fix (selected)

**Combination:** Docker Compose all-in-one + GitHub binary releases + on-chain compressed state commitments + auto-config wizard + WASM client prover roadmap.

**Description:** Provide a `docker-compose.yml` that spins up a full local stack (indexer, guardian, bridges, client) for operators and developers. Publish signed GitHub releases for CLI binaries. Use compact on-chain `RootCommit` anchors for indexer consensus. Add an interactive config wizard (`vela init`) to generate operator/client configs. Keep WASM client proving as a later performance milestone once the Rust/PyO3 prover is ready.

**Score:** 90/100

## No external smart contracts

All deployment and scaling mechanisms are infrastructure, client, or indexer conventions. None require smart contracts.
