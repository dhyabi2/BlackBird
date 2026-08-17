# BlackBird

A decentralized privacy layer for Nano (XNO). Users deposit into a common pool and withdraw to fresh addresses using Groth16 zero-knowledge proofs. The pool key is controlled by a threshold guardian network, so no single machine ever holds the funds.

Live app: https://www.xblackbird.com

> For the full protocol design, see [`DESIGN.md`](DESIGN.md).

## Repository Layout

```
DESIGN.md                  # Protocol specification and architecture
src/
  vela_crypto.py           # Nano crypto + Poseidon commitments/nullifiers
  poseidon_bridge.py       # Python → Node Poseidon/circomlibjs bridge
  snarkjs_bridge.py        # Python → snarkjs Groth16 prove/verify bridge
  vela_indexer.py          # Tracks deposits/commitments, Poseidon Merkle trees
  vela_guardian.py         # Guardian service (threshold signing in implementation phase)
  vela_client.py           # CLI for deposits and withdrawals
circuit/
  vela.circom              # Circom withdrawal circuit
  build/                   # Compiled circuit artifacts (r1cs, wasm, zkey, vk)
  poseidon_js/             # Node.js snarkjs helper
docs/
  VELA_v2_architecture.bpmn # Full BPMN 2.0 model of the protocol
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

A single-guardian deployment is running on a Hostinger VPS for testing and integration:

- **Web app:** https://www.xblackbird.com
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

### 2. Configure Nano RPC

BlackBird uses [rpc.nano.to](https://rpc.nano.to) as the only Nano RPC endpoint. Obtain an API key from rpc.nano.to and set it as an environment variable:

```bash
export NANO_RPC_KEY=<YOUR_RPC_NANO_TO_KEY>
```

Or create a `.env` file in the project root (it is gitignored):

```bash
echo 'NANO_RPC_KEY=<YOUR_RPC_NANO_TO_KEY>' >> .env
```

The key is sent as an `Authorization: <key>` header and also as a `key` body parameter for compatibility with `rpc.nano.to`.

The endpoint is fixed to `https://rpc.nano.to`; public fallback endpoints are not used, so the RPC key is never sent elsewhere.

### 3. Generate a BlackBird ID

```bash
source venv/bin/activate
python3 -m src.vela_client generate
```

Save the output (`seed_view`, `A`, `B`).

### 4. Fund a source account

Create or use an existing Nano account and send it at least the wallet-friendly amount shown in the UI (e.g., 1.000001 XNO for the 1 XNO pool). The UI adds 0.000001 XNO of padding so mobile wallets can display the full amount; the protocol itself only consumes `denomination + 1` raw.

### 5. Prepare a deposit

```bash
python3 -m src.vela_client deposit <source_seed_hex> <seed_view_hex> 1
```

This prints unsigned deposit and commitment blocks with PoW. Broadcast them to the Nano network (e.g., via a local Nano node or public RPC that accepts `process`). The commitment is a BN254 field element encoded as a 32-byte `link` field.

### 6. Submit to indexer

After both blocks are confirmed, tell the indexer about the pair:

```bash
curl -X POST http://<vps-ip-or-onion>:8080/submit \
  -H "Content-Type: application/json" \
  -d '{"deposit_hash":"...","commit_hash":"..."}'
```

The indexer verifies the deposit→pool transfer, computes the Poseidon commitment from the commitment block's `link`, and inserts it into the epoch/denomination Merkle tree.

### 7. Request withdrawal

The client fetches the Merkle proof from the indexer, generates a Groth16 proof locally with snarkjs, and sends it to the guardian network:

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

## Production Status

The current deployed instance uses a single guardian for integration testing. The production design in [`DESIGN.md`](DESIGN.md) uses a `t-of-n` FROST threshold guardian network.

## License

Prototype — use at your own risk.
