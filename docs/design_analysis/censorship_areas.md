# Censorship-Critical Areas in VELA v2

This document lists every protocol component where censorship is possible, either by a single actor or by a colluding minority. Each area is a candidate for the brainstorming methodology.

## 1. Indexer censorship

**What can be censored:**
- An indexer can refuse to accept a `deposit_hash`/`commit_hash` pair.
- An indexer can refuse to publish a root for an epoch/denomination.
- An indexer can publish a wrong or incomplete root.
- An indexer can refuse to serve inclusion proofs for specific commitments.

**Actors:** Indexer operators.

**Current mitigations:** Multiple independent indexers; deterministic root computation; `RootCommit` transactions on Nano.

## 2. Guardian censorship

**What can be censored:**
- A guardian can refuse to verify a ZK proof.
- A guardian can refuse to return a partial signature.
- A guardian can delay signatures indefinitely.
- A quorum of guardians can blacklist specific depositors or withdrawal recipients.

**Actors:** Guardian operators (any subset < `t`).

**Current mitigations:** `t-of-n` threshold; any `t` honest guardians can sign; client can contact guardians directly.

## 3. Coordinator / relay censorship

**What can be censored:**
- A coordinator can refuse to forward a withdrawal request to guardians.
- A coordinator can refuse to return collected partial signatures.
- A coordinator can refuse to broadcast the final Nano block.
- A coordinator can throttle or blacklist specific clients.

**Actors:** Optional coordinators/relays.

**Current mitigations:** Coordinator is optional; client can act as aggregator; multiple coordinators allowed.

## 4. Nano RPC / node censorship

**What can be censored:**
- An RPC provider can refuse to serve `account_info` or `blocks_info`.
- An RPC provider can refuse `process` for withdrawal blocks.
- An RPC provider can rate-limit or IP-block the indexer/guardian/client.
- A dominant representative set could theoretically censor confirmations.

**Actors:** RPC providers, Nano representatives, ISPs.

**Current mitigations:** Multiple public fallbacks; client can use any RPC; representative voting is decentralized.

## 5. Work-generation censorship

**What can be censored:**
- A `work_generate` provider can refuse to compute PoW.
- A client without local PoW capability cannot broadcast if remote PoW is censored.

**Actors:** PoW providers, RPC providers.

**Current mitigations:** Client can compute PoW locally (CPU); multiple RPC fallbacks.

## 6. Network / transport censorship

**What can be censored:**
- ISPs can block HTTPS endpoints.
- Governments can block Tor.
- DNS can be hijacked to point to malicious endpoints.

**Actors:** ISPs, governments, DNS operators.

**Current mitigations:** Tor hidden services for guardian/indexer endpoints; no private network required.

## 7. Bootstrap / endpoint discovery censorship

**What can be censored:**
- A hardcoded bootstrap list can be blocked or become stale.
- A Nostr relay can refuse to serve guardian/indexer announcements.
- On-chain announcements can be frontrun or spammed.

**Actors:** DNS operators, relay operators, on-chain spammers.

**Current mitigations:** Multiple discovery channels (hardcoded, Nostr, on-chain); `RootCommit` transactions expose indexer identities.

## 8. External slashing-contract censorship

**What can be censored:**
- The EVM L2 used for bonds/slashing can censor fraud-proof submissions.
- A sequencer can reorder or censor slashing transactions.

**Actors:** L2 sequencers, validators, bridge operators.

**Current mitigations:** Use a widely decentralized L2; social fallback on Nano.

## 9. Trusted-dealer censorship (prototype only)

**What can be censored:**
- In the prototype, the trusted dealer can refuse to distribute shares to some guardians.
- The dealer can selectively exclude operators from the signer set.

**Actors:** Trusted dealer.

**Current mitigations:** Production DKG removes the dealer; prototype assumes honest dealer.

## 10. Dependency / supply-chain censorship

**What can be censored:**
- npm/pip registries can remove packages.
- GitHub can suspend the repository.
- CDN-hosted circuit artifacts can be blocked.

**Actors:** Package registries, GitHub, CDNs, governments.

**Current mitigations:** Pin dependencies; vendor critical packages; self-host circuit artifacts.

## 11. Hosting / VPS censorship

**What can be censored:**
- Hostinger can suspend the VPS.
- Domain names can be seized.

**Actors:** Hosting providers, domain registrars.

**Current mitigations:** Tor hidden services do not depend on DNS or hosting IP; multiple operators run services.

## Priority order for brainstorming

1. Indexer censorship (high impact on usability)
2. Guardian censorship (high impact on withdrawals)
3. Coordinator/relay censorship (already partially addressed)
4. RPC/node censorship (critical liveness layer)
5. Bootstrap/discovery censorship (needed for permissionless entry)
6. Network/transport censorship (already partially addressed)
7. External slashing-contract censorship (secondary economic layer)
