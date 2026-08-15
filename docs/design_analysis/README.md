# VELA v2 Critical Design Area Analyses

This directory contains the ranked brainstorming outputs for each critical design area. Each file records the methodology, the rejected ideas, the ranked mechanisms, and the selected composite fix.

## Areas analyzed

### Original critical areas

| Area | Status | Analysis file | Merged PR |
|------|--------|---------------|-----------|
| FROST custody / Ed25519-blake2b ciphersuite | Done | (embedded in DESIGN.md) | #1 |
| Indexer consensus / RootCommit | Done | (embedded in DESIGN.md) | #1 |
| Coordinator trust / censorship / front-running | Done | (embedded in DESIGN.md) | #2 |
| Economic slashing without Nano smart contracts | Done | (embedded in DESIGN.md) | #3 |
| Client proof-generation performance | Done | (embedded in DESIGN.md) | #4 |
| Use rpc.nano.to as default RPC | Done | (code change) | #5 |
| DKG and share refresh | Done | [`dkg_share_refresh.md`](dkg_share_refresh.md) | #6 |
| Privacy leaks (recipient/amount public) | Done | [`privacy_leaks.md`](privacy_leaks.md) | #7 |
| Front-running / nullifier racing | Done | [`front_running_nullifier_racing.md`](front_running_nullifier_racing.md) | #8 |

### Censorship-specific areas

| Area | Status | Analysis file |
|------|--------|---------------|
| Indexer censorship | Done | [`indexer_censorship.md`](indexer_censorship.md) |
| Guardian censorship | Done | [`guardian_censorship.md`](guardian_censorship.md) |
| Coordinator / relay censorship | Done | [`coordinator_censorship.md`](coordinator_censorship.md) |
| RPC / provider censorship | Done | [`rpc_censorship.md`](rpc_censorship.md) |
| Bootstrap / discovery censorship | Done | [`discovery_censorship.md`](discovery_censorship.md) |
| Network / transport censorship | Done | [`transport_censorship.md`](transport_censorship.md) |
| Master censorship area list | Done | [`censorship_areas.md`](censorship_areas.md) |

## Methodology used

1. **Initial ideas**: Methodology-Tree engine (`POST https://methodology-tree-web.vercel.app/api/v1/run`, `x-api-key: XNO_SUPER`, mode=deep).
2. **Refinement & ranking**: OpenRouter `deepseek/deepseek-v4-flash-0731`.
3. **Selection**: Human judgment applied to filter model errors (e.g., the refinement model incorrectly rejected fixed denominations for privacy; it also suggested smart-contract enforcement where Nano has none).

## Author's notes on selections

- **Fixed denominations** were kept despite the model's objection because they are a standard and effective unlinkability mechanism for pool-based designs.
- **External-chain slashing** was accepted as the only practical way to enforce real economic penalties on a chain without smart contracts.
- **Deterministic FROST nonces** were explicitly rejected as unsafe; random or per-session nonces are required.
- **Threshold encryption of P_w** was not adopted as a core fix because binding `P_w` into the signed message already prevents coordinator front-running.
- **Transparency-based mitigations** (public logs, accountability) were kept for censorship areas because, on Nano, transparency creates social/economic pressure when automatic enforcement is impossible.
