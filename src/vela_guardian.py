"""
VELA v2 Guardian.

Single-key guardian implementation that holds the pool signing key, verifies
Groth16 ZK withdrawal proofs, and signs/broadcasts Nano withdrawal transactions.

The production design uses a t-of-n FROST threshold signer set so that no
single machine controls the pool key. See DESIGN.md for the full architecture.
"""
import functools
import json
import os
import secrets
import tempfile
import threading
import time
from typing import Optional

import requests
from flask import Flask, request, jsonify

from .vela_crypto import (
    pool_keypair,
    pool_address,
    nano_pubkey_from_address,
    nano_state_block_hash,
    sign_message,
)
from .poseidon_bridge import split32
from .snarkjs_bridge import verify_proof
from .nano_rpc import NanoRPC
from .vela_constants import EPOCH_SECONDS, FEE_BPS, DENOMINATIONS


def withdraw_fee_for(denomination: int) -> int:
    """Return the guardian fee in raw for a given denomination.

    Fee is 0.5% (50 basis points) of the denomination, rounded down.
    """
    return (denomination * FEE_BPS) // 10_000


def require_api_key(f):
    @functools.wraps(f)
    def decorated(*args, **kwargs):
        expected = os.environ.get("VELA_API_KEY", "")
        if not expected:
            return jsonify({"error": "API key not configured"}), 500
        provided = request.headers.get("X-VELA-API-Key", "")
        if not provided or not secrets.compare_digest(expected, provided):
            return jsonify({"error": "unauthorized"}), 401
        return f(*args, **kwargs)
    return decorated


class VelaGuardian:
    def __init__(self, seed: bytes, indexer_url: str = "http://127.0.0.1:8080", data_dir: str = "data"):
        self.seed = seed
        self.indexer_url = indexer_url
        self.data_dir = data_dir
        self.session = requests.Session()
        self.rpc = NanoRPC()
        self.spent_nullifiers: set = set()
        self._lock = threading.Lock()
        self._load_state()

    def _state_path(self) -> str:
        return os.path.join(self.data_dir, "guardian_state.json")

    def _load_state(self):
        os.makedirs(self.data_dir, exist_ok=True)
        path = self._state_path()
        if os.path.exists(path):
            try:
                with open(path) as f:
                    data = json.load(f)
                self.spent_nullifiers = set(int(x, 16) for x in data.get("nullifiers", []))
            except Exception as e:
                print("Guardian load state error:", e)

    def _save_state(self):
        """Atomically persist state with restricted permissions."""
        os.makedirs(self.data_dir, exist_ok=True)
        path = self._state_path()
        fd, tmp = tempfile.mkstemp(dir=self.data_dir, suffix=".tmp")
        try:
            with os.fdopen(fd, "w") as f:
                json.dump({"nullifiers": [hex(x) for x in self.spent_nullifiers]}, f)
            os.chmod(tmp, 0o600)
            os.replace(tmp, path)
        except Exception:
            try:
                os.unlink(tmp)
            except Exception:
                pass
            raise

    def _indexer_get(self, path: str) -> dict:
        resp = self.session.get(self.indexer_url + path, timeout=10)
        resp.raise_for_status()
        return resp.json()

    def _get_account_info(self, address: str) -> dict:
        return self.rpc.call("account_info", {"account": address, "representative": "true"})

    def _broadcast_block(self, block: dict) -> dict:
        return self.rpc.call("process", {"json_block": "true", "block": block})

    def verify_withdrawal_request(self, req: dict) -> Optional[dict]:
        """
        Verify a ZK withdrawal request.

        Required fields:
          - epoch, denomination
          - P_w: 32-byte withdrawal pubkey (hex)
          - nullifier (hex int)
          - proof: snarkjs Groth16 proof object
          - publicSignals: list [root, nullifier, P_w_lo, P_w_hi]
        """
        try:
            epoch = int(req["epoch"])
            denomination = int(req["denomination"])
            if denomination not in DENOMINATIONS:
                return None
            P_w = bytes.fromhex(req["P_w"])
            N = int(req["nullifier"], 16)
            proof = req["proof"]
            public_signals = req["publicSignals"]

            if denomination not in DENOMINATIONS:
                return None

            if len(public_signals) != 4:
                return None

            pub_root = int(public_signals[0])
            pub_nullifier = int(public_signals[1])
            pub_P_w_lo = int(public_signals[2])
            pub_P_w_hi = int(public_signals[3])

            if pub_nullifier != N:
                return None

            P_w_lo, P_w_hi = split32(P_w)
            if pub_P_w_lo != P_w_lo or pub_P_w_hi != P_w_hi:
                return None

            # Root must match indexer
            root_info = self._indexer_get(f"/root/{epoch}/{denomination}")
            expected_root = int(root_info["root"], 16)
            if pub_root != expected_root:
                return None

            if not verify_proof(proof, public_signals):
                return None

            return {
                "P_w": P_w,
                "denomination": denomination,
                "N": N,
            }
        except Exception as e:
            print("verify withdrawal error:", e)
            return None

    def withdraw(self, req: dict) -> dict:
        verified = self.verify_withdrawal_request(req)
        print("withdraw verify result:", verified)
        if verified is None:
            return {"error": "verification failed"}

        denomination = verified["denomination"]
        P_w = verified["P_w"]
        N = verified["N"]

        # Derive the spendable pool keypair for this denomination.
        pool_sk, pool_pub = pool_keypair(denomination, self.seed)
        pool_addr = pool_address(denomination, self.seed)

        # Fetch pool account info outside the lock.
        info = self._get_account_info(pool_addr)
        if "error" in info:
            return {"error": f"pool account info failed: {info['error']}"}

        balance = int(info["balance"])
        previous = bytes.fromhex(info["frontier"])
        representative = nano_pubkey_from_address(info["representative"])
        fee_raw = withdraw_fee_for(denomination)
        send_amount = denomination - fee_raw
        new_balance = balance - send_amount
        if new_balance < 0:
            return {"error": "insufficient pool balance"}

        # Prevent concurrent double-spend of the same nullifier.
        with self._lock:
            if N in self.spent_nullifiers:
                return {"error": "nullifier already spent"}

            block_hash = nano_state_block_hash(
                pool_pub,
                previous,
                representative,
                new_balance,
                P_w,
            )
            signature = sign_message(pool_sk, block_hash)

            block = {
                "type": "state",
                "account": pool_addr,
                "previous": previous.hex(),
                "representative": info["representative"],
                "balance": str(new_balance),
                "link": P_w.hex(),
                "signature": signature.hex(),
                "work": "0000000000000000",
            }

            self.spent_nullifiers.add(N)
            self._save_state()

        return {
            "ok": True,
            "block": block,
            "block_hash": block_hash.hex(),
            "nullifier": hex(N),
            "fee_raw": fee_raw,
            "send_amount_raw": send_amount,
        }


def create_app(guardian: VelaGuardian) -> Flask:
    app = Flask(__name__)

    @app.route("/")
    def health():
        return jsonify({"status": "ok"})

    @app.route("/pool_address")
    def pool_address_route():
        return jsonify({"address": pool_address(10**30, guardian.seed)})

    @app.route("/fee")
    def fee_route():
        return jsonify({"fee_bps": FEE_BPS, "note": "0.5% of denomination"})

    @app.route("/withdraw", methods=["POST"])
    @require_api_key
    def withdraw():
        data = request.json or {}
        result = guardian.withdraw(data)
        if "error" in result:
            return jsonify(result), 400
        return jsonify(result)

    return app


if __name__ == "__main__":
    from waitress import serve
    import sys
    seed_hex = os.environ.get("GUARDIAN_SEED")
    if not seed_hex:
        print("Set GUARDIAN_SEED env var")
        sys.exit(1)
    seed = bytes.fromhex(seed_hex)
    guardian = VelaGuardian(seed)
    app = create_app(guardian)
    serve(app, host="127.0.0.1", port=8081)
