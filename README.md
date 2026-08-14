# VELA v2 — Groth16-Integrated Prototype

This repository contains a working implementation of the VELA v2 layer-2 privacy protocol for Nano (XNO), including the revised specification, the Circom Groth16 circuit, and Python services that generate and verify real ZK proofs for withdrawals.

**⚠️ WARNING:** This is an unaudited prototype. It uses a single guardian and does not use FROST threshold signing. Do not use it with mainnet funds without further audit and hardening.

## Repository Layout

```
VELA_revised_v2.md         # Corrected protocol specification
src/
  vela_crypto.py           # Nano crypto + Poseidon commitments/nullifiers
  poseidon_bridge.py       # Python → Node Poseidon/circomlibjs bridge
  snarkjs_bridge.py        # Python → snarkjs Groth16 prove/verify bridge
  vela_indexer.py          # Tracks deposits/commitments, Poseidon Merkle trees
  vela_guardian.py         # Verifies Groth16 proofs, signs withdrawals
  vela_client.py           # CLI for deposits and withdrawals
circuit/
  vela.circom              # Circom withdrawal circuit
  build/                   # Compiled circuit artifacts (r1cs, wasm, zkey, vk)
  poseidon_js/             # Node.js snarkjs helper
scripts/
  poseidon_helper.mjs      # Node Poseidon/Merkle helper
  deploy.sh                # Deploy to Hostinger VPS
  setup_vps.sh             # One-time VPS setup
  start_indexer.sh         # Start indexer service
  start_guardian.sh        # Start guardian service
config/
  vela-indexer.service
  vela-guardian.service
```

## Deployed Services

The prototype is deployed on a Hostinger VPS (187.127.123.229):

- **Indexer:** `http://127.0.0.1:8080` (VPS localhost) / Tor: `ejg5mnh3lvhmgwyrxrbzuqgd3k3siplndsxhzht23vxitjxppf2yukid.onion`
- **Guardian:** `http://127.0.0.1:8081` (VPS localhost) / Tor: `jnigdgannexjxemablsyxwf6uass3ufcq4xu6eftmrwadym3z3dleyad.onion`
- **Pool address:** derived from the guardian seed; see `/pool_address` on the guardian.

## Quick Start

### 1. Install dependencies

```bash
python3.14 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
npm install
```

The circuit must be compiled and trusted-setup artifacts generated before real proofs can be produced (see `circuit/build/`).

### 2. Generate a VelaID

```bash
source venv/bin/activate
python3 -m src.vela_client generate
```

Save the output (`seed_view`, `A`, `B`).

### 3. Fund a source account

Create or use an existing Nano account and send it at least `denomination + 1` raw (e.g., 1.000000001 XNO for the 1 XNO pool).

### 4. Prepare a deposit

```bash
python3 -m src.vela_client deposit <source_seed_hex> <seed_view_hex> 1
```

This prints unsigned deposit and commitment blocks with PoW. Broadcast them to the Nano network (e.g., via a local Nano node or public RPC that accepts `process`). The commitment is a BN254 field element encoded as a 32-byte `link` field.

### 5. Submit to indexer

After both blocks are confirmed, tell the indexer about the pair:

```bash
curl -X POST http://<vps-ip-or-onion>:8080/submit \
  -H "Content-Type: application/json" \
  -d '{"deposit_hash":"...","commit_hash":"..."}'
```

The indexer verifies the deposit→pool transfer, computes the Poseidon commitment from the commitment block's `link`, and inserts it into the epoch/denomination Merkle tree.

### 6. Request withdrawal

The client fetches the Merkle proof from the indexer, generates a Groth16 proof locally with snarkjs, and sends it to the guardian:

```bash
python3 -m src.vela_client withdraw \
  <n_hex> <t_hex> <P_w_hex> <S_pub_hex> \
  1 <epoch> \
  --indexer-url http://<vps>:8080 \
  --guardian-url http://<vps>:8081
```

The guardian verifies the ZK proof, checks the nullifier is unspent, and returns a signed withdrawal block. Compute PoW and broadcast it, or add `--broadcast` to let the client compute PoW and broadcast via a public RPC.

## Tests

Run the local end-to-end test with mocked Nano RPC and real Groth16 proofs:

```bash
python tests/test_e2e.py
python tests/test_zk.py
```

## Production Gaps

- **FROST threshold signing:** the prototype uses a single pool signing key.
- **Tor-only client traffic:** services are exposed as hidden services, but clients should also route all traffic over Tor.
- **Fee sweep automation:** fees accumulate in the pool but are not auto-swept.
- **Real Nano node:** public RPC endpoints are used; live operation requires a synced node or beta-network funds for testing.

## License

Prototype — use at your own risk.
