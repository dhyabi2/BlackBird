# VELA v2 — Core Prototype

This repository contains a **working prototype** of the VELA v2 layer-2 privacy protocol for Nano (XNO), including the revised specification and a minimal Python implementation.

**⚠️ WARNING:** This is a prototype. It uses a single guardian, simplified Merkle proofs (Blake2b instead of Poseidon), and does not integrate the Circom ZK proof into the withdrawal flow. Do not use it with significant real funds without further audit and hardening.

## Repository Layout

```
VELA_revised_v2.md    # Corrected protocol specification
src/
  vela_crypto.py      # Nano addresses, Ed25519-blake2b signing, stealth addresses
  vela_indexer.py     # Tracks deposits/commitments and builds Merkle trees
  vela_guardian.py    # Single-key guardian API for withdrawals
  vela_client.py      # CLI for deposits and withdrawals
circuit/
  vela.circom         # Circom withdrawal circuit (compiled but not yet integrated)
  build/              # Compiled circuit artifacts
scripts/
  deploy.sh           # Deploy to Hostinger VPS
  setup_vps.sh        # One-time VPS setup
  start_indexer.sh    # Start indexer service
  start_guardian.sh   # Start guardian service
config/
  vela-indexer.service
  vela-guardian.service
```

## Deployed Services

The prototype is deployed on a Hostinger VPS (187.127.123.229):

- **Indexer:** `http://127.0.0.1:8080` (VPS localhost) / Tor: `ejg5mnh3lvhmgwyrxrbzuqgd3k3siplndsxhzht23vxitjxppf2yukid.onion`
- **Guardian:** `http://127.0.0.1:8081` (VPS localhost) / Tor: `jnigdgannexjxemablsyxwf6uass3ufcq4xu6eftmrwadym3z3dleyad.onion`
- **Pool address:** `nano_dzb6fh849xzauhjtbue8o9h8go3ezmkbtr5nmy5i93kcbcwsjbs1irw4dy8k`

## Quick Start

### 1. Generate a VelaID

```bash
source venv/bin/activate
python3 -m src.vela_client generate
```

Save the output (seed_view, seed_spend, A, B).

### 2. Fund a source account

Create or use an existing Nano account and send it at least `denomination + 1` raw (e.g., 1.000000001 XNO for the 1 XNO pool).

### 3. Prepare a deposit

```bash
python3 -m src.vela_client deposit <source_seed_hex> <seed_view_hex> 1
```

This prints unsigned deposit and commitment blocks with PoW. You must broadcast them to the Nano network (e.g., via a local Nano node or public RPC that accepts `process`).

### 4. Submit to indexer

After both blocks are confirmed, tell the indexer about the pair:

```bash
curl -X POST http://<vps-ip-or-onion>:8080/submit \
  -H "Content-Type: application/json" \
  -d '{"deposit_hash":"...","commit_hash":"..."}'
```

### 5. Request withdrawal

Wait for the epoch to close and the guardian to publish the root, then:

```bash
python3 -m src.vela_client withdraw \
  <source_seed_hex> <n_hex> <t_hex> <P_w_hex> <S_pub_hex> \
  <deposit_hash> 1 <epoch> \
  --indexer-url http://<vps>:8080 \
  --guardian-url http://<vps>:8081
```

The guardian returns a signed withdrawal block. Compute PoW and broadcast it.

## Production Gaps

- ZK proof integration: the Circom circuit is compiled but the guardian currently verifies commitments with raw source public keys.
- FROST threshold signing: the prototype uses a single pool signing key.
- Tor/I2P: configured for hidden services but client traffic should also be forced over Tor.
- Real Poseidon Merkle tree: the indexer uses Blake2b for prototyping.
- Fee sweep automation: fees accumulate in the pool but are not auto-swept.

## License

Prototype — use at your own risk.
