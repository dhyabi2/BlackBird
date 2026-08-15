# Critical Area Analysis: Bootstrap / Discovery Censorship

## Methodology

1. Initial ideas: Methodology-Tree engine (`POST /api/v1/run`, mode=deep).
2. Refinement/ranking: `deepseek/deepseek-v4-flash-0731`.

## Invalid or weak ideas

| ID | Name | Why rejected |
|----|------|--------------|
| 9 | Nano block metadata embedding | Nano blocks have no general-purpose data field; spams ledger; cannot update/revoke. |
| 10 | Cross-chain signal verification | Requires bridges/oracles; unnecessary for endpoint discovery. |

## Ranked mechanisms

| Rank | Name | Mechanism | Threat | Required change | Drawback | Score |
|------|------|-----------|--------|-----------------|----------|-------|
| 1 | Multi-source intersection with verifiable signatures | Clients fetch signed manifests from Nostr, DHT, IPFS, Tor/I2P; accept only if >=N sources match and signatures verify. | Single-source censorship or forgery. | Client threshold aggregation; signed manifests. | Initial trust anchors needed; Sybil spam possible. | 92 |
| 2 | Gossip bootstrap via libp2p DHT | Guardians announce via Kademlia DHT; clients bootstrap from small seed set. | DNS/relay blocking. | libp2p DHT client. | DHT pollution/Sybil; NAT traversal. | 87 |
| 3 | Content-addressed IPFS pinning with signed manifests | Endpoint manifests published to IPFS by CID; signed and optionally IPNS/DNSLink updated. | Domain seizure/server shutdown. | IPFS publisher/resolver. | Pinning availability; gateway blocking. | 82 |
| 4 | DHT lookup with signed provider records | Signed endpoint records stored under protocol key in DHT. | Centralized directory censorship. | DHT record storage/lookup. | Record refresh; eclipse risk. | 78 |
| 5 | Signed Nostr relay announcements | Guardians publish signed manifests to multiple Nostr relays. | Relay censorship. | Nostr client; relay diversity. | Spam; relay retention not guaranteed. | 75 |
| 6 | Tor/I2P hidden service endpoints | Guardian/indexer endpoints as .onion/.i2p addresses. | ISP/DNS blocking. | Tor/I2P transport support. | Higher latency; some networks block Tor. | 73 |
| 7 | On-chain anchors in Nano RootCommit | Anchor manifest hash in RootCommit for tamper-evident timestamp. | Stale/fake lists. | Anchor-writing service; client verification. | Not a discovery channel by itself. | 70 |
| 8 | Social graph trust | Use Nostr/SSB social graph to weight publishers. | Sybil fake endpoints. | Social-graph scoring. | Cold-start; privacy; gaming. | 66 |
| 9 | Hardcoded cold start with out-of-band updates | Ship client with signed bootstrap manifest; update via signed releases. | Total dynamic discovery failure. | Signed bootstrap manifest. | Static; slow updates. | 63 |
| 10 | Encrypted DNS and multi-domain fallback | DoH/DoT + multiple domains with DNSSEC. | DNS blocking. | DoH/DoT resolvers; domain rotation. | Domain seizure still possible. | 55 |

## Composite fix (selected)

**Combination:** Multi-source intersection + libp2p DHT gossip + IPFS signed manifests + Nostr relay announcements + RootCommit anchoring + Tor/I2P fallback + hardcoded cold start.

**Description:** Publish signed endpoint manifests to DHT, IPFS, and Nostr; anchor the manifest hash in Nano RootCommit; include Tor/I2P addresses. Clients bootstrap from hardcoded seeds, discover via multiple channels, verify signatures, require threshold intersection, and fall back to hidden services if clearnet is blocked.

**Score:** 93/100

## Author's note

VELA v2 currently mentions hardcoded bootstrap, Nostr, and on-chain announcements. The concrete next steps are: signed manifests, multi-channel distribution, and Tor/I2P fallback.
