# Critical Area Analysis: Network / Transport Censorship

## Methodology

Initial ideas: Methodology-Tree engine (`POST /api/v1/run`, mode=deep). No OpenRouter refinement; transport-layer mitigations are well understood and overlap with discovery/coordinator analyses.

## Ranked mechanisms

| Rank | Name | Mechanism | Threat | Required change | Drawback | Score |
|------|------|-----------|--------|-----------------|----------|-------|
| 1 | Dynamic transport fallback chains | Client tries HTTPS, Tor, WebSocket, QUIC in parallel; uses first working transport. | ISP protocol filtering, single-point failures. | Transport abstraction + fallback logic. | Redundant connection attempts. | 95 |
| 2 | Tor hidden service endpoints | Guardians/indexers expose `.onion` addresses that are hard to block individually. | IP/domain blocking, DNS seizure. | Tor daemon or Tor library integration. | Higher latency; some networks block Tor. | 90 |
| 3 | HTTP/2 multiplexed obfuscation | Tunnel VELA traffic over standard HTTPS/2 streams. | Deep packet inspection. | HTTP/2 client/server. | Slight header overhead. | 85 |
| 4 | Nano-chain endpoint registry | Guardians publish new transport addresses via signed Nano messages. | Static endpoint blocking. | Chain monitoring + address parsing. | Latency for discovery. | 80 |
| 5 | Plausible deniability noise | Dummy traffic when idle. | Traffic analysis. | Noise generator. | Bandwidth waste. | 50 |
| 6 | Steganographic payloads | Embed messages in common media. | Content filtering. | Encoder/decoder. | Low bandwidth; complex. | 40 |

## Composite fix (selected)

**Combination:** Dynamic transport fallback chains + Tor hidden services + HTTP/2 obfuscation + Nano-chain endpoint registry.

**Description:** Expose each guardian/indexer over HTTPS, Tor, and WebSocket. Clients try them in parallel and use the first working transport. Publish transport addresses via signed Nano messages so they can be rotated if blocked. Use HTTPS/2 where possible to blend with normal web traffic.

**Score:** 93/100

## Author's note

VELA v2 already mentions Tor hidden services. The next step is a transport fallback chain and address rotation via signed Nano messages.
