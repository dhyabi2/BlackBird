"""
VELA v2 Guardian.

Single-key guardian implementation that holds the pool signing key, verifies
Groth16 ZK withdrawal proofs, and signs/broadcasts Nano withdrawal transactions.

The production design uses a t-of-n FROST threshold signer set so that no
single machine controls the pool key. See DESIGN.md for the full architecture.
"""
import json
import os
import time
from typing import List, Optional

import requests
from flask import Flask, request, jsonify

from .vela_crypto import (
    nano_seed_to_keypair,
    nano_address_from_pubkey,
    nano_pubkey_from_address,
    nano_state_block_hash,
    sign_message,
)
from .poseidon_bridge import split32, field_to_bytes32
from .snarkjs_bridge import verify_proof
from .nano_rpc import NanoRPC

EPOCH_SECONDS = 86400
FEE_BPS = 50  # 0.5% guardian fee


def withdraw_fee_for(denomination: int) -> int:
    """Return the guardian fee in raw for a given denomination.

    Fee is 0.5% (50 basis points) of the denomination, rounded down.
    """
    return (denomination * FEE_BPS) // 10_000


class VelaGuardian:
    def __init__(self, seed: bytes, indexer_url: str = "http://127.0.0.1:8080", data_dir: str = "data"):
        self.seed = seed
        self.indexer_url = indexer_url
        self.data_dir = data_dir
        self.session = requests.Session()
        # Pool keypair for all denominations (simplification; production uses DKG per denom)
        self.pool_sk, self.pool_pub = nano_seed_to_keypair(seed, index=0)
        self.pool_address = nano_address_from_pubkey(self.pool_pub)
        self.rpc = NanoRPC()
        self.spent_nullifiers: set = set()
        self._load_state()

    def _state_path(self) -> str:
        return os.path.join(self.data_dir, "guardian_state.json")

    def _load_state(self):
        os.makedirs(self.data_dir, exist_ok=True)
        if os.path.exists(self._state_path()):
            try:
                with open(self._state_path()) as f:
                    data = json.load(f)
                self.spent_nullifiers = set(int(x, 16) for x in data.get("nullifiers", []))
            except Exception as e:
                print("Guardian load state error:", e)

    def _save_state(self):
        os.makedirs(self.data_dir, exist_ok=True)
        with open(self._state_path(), "w") as f:
            json.dump({"nullifiers": [hex(x) for x in self.spent_nullifiers]}, f)

    def _indexer_get(self, path: str) -> dict:
        resp = self.session.get(self.indexer_url + path, timeout=10)
        resp.raise_for_status()
        return resp.json()

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
            P_w = bytes.fromhex(req["P_w"])
            N = int(req["nullifier"], 16)
            proof = req["proof"]
            public_signals = req["publicSignals"]

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

            if N in self.spent_nullifiers:
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

    def _get_account_info(self, address: str) -> dict:
        return self.rpc.call("account_info", {"account": address, "representative": "true"})

    def _broadcast_block(self, block: dict) -> dict:
        return self.rpc.call("process", {"json_block": "true", "block": block})

    def withdraw(self, req: dict) -> dict:
        verified = self.verify_withdrawal_request(req)
        print("withdraw verify result:", verified)
        if verified is None:
            return {"error": "verification failed"}

        denomination = verified["denomination"]
        P_w = verified["P_w"]
        N = verified["N"]

        info = self._get_account_info(self.pool_address)
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

        block_hash = nano_state_block_hash(
            self.pool_pub,
            previous,
            representative,
            new_balance,
            P_w,
        )
        signature = sign_message(self.pool_sk, block_hash)

        block = {
            "type": "state",
            "account": self.pool_address,
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
        return jsonify({"status": "ok", "pool_address": guardian.pool_address})

    @app.route("/pool_address")
    def pool_address_route():
        return jsonify({"address": guardian.pool_address})

    @app.route("/fee")
    def fee_route():
        return jsonify({"fee_bps": FEE_BPS, "note": "0.5% of denomination"})

    @app.route("/withdraw", methods=["POST"])
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
