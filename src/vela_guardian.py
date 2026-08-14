"""
VELA v2 Guardian (prototype).

Single-key guardian that holds the pool signing key, verifies withdrawal
requests, and signs/broadcasts Nano withdrawal transactions.

WARNING: This prototype uses a single guardian and does NOT use real ZK
proofs. The guardian sees the source public key. Production must use
FROST threshold signing and a Circom Groth16 proof.
"""

import json
import os
import struct
import time
from typing import List, Optional

import requests
from flask import Flask, request, jsonify

from .vela_crypto import (
    blake2b_256,
    nano_seed_to_keypair,
    nano_address_from_pubkey,
    nano_pubkey_from_address,
    nano_state_block_hash,
    sign_message,
    verify_signature,
    compute_commitment,
    compute_nullifier,
    pool_address,
    pool_pubkey,
    sign_with_scalar,
)

EPOCH_SECONDS = 86400
WITHDRAW_FEE_RAW = int(0.01 * 10**30)
NANO_RPC_ENDPOINTS = [
    "https://app.nanolooker.com/api/rpc",
    "https://proxy.nanos.cc/proxy",
]


class NanoRPC:
    def __init__(self, endpoints: List[str] = NANO_RPC_ENDPOINTS):
        self.endpoints = endpoints
        self.session = requests.Session()

    def call(self, action: str, params: dict) -> dict:
        last_err = None
        for endpoint in self.endpoints:
            try:
                payload = {"action": action, **params}
                resp = self.session.post(endpoint, json=payload, timeout=15)
                resp.raise_for_status()
                return resp.json()
            except Exception as e:
                last_err = e
                continue
        raise RuntimeError(f"All Nano RPC endpoints failed: {last_err}")


class VelaGuardian:
    def __init__(self, seed: bytes, indexer_url: str = "http://127.0.0.1:8080"):
        self.seed = seed
        self.indexer_url = indexer_url
        self.session = requests.Session()
        # Pool keypair for all denominations (simplification; production uses DKG per denom)
        self.pool_sk, self.pool_pub = nano_seed_to_keypair(seed, index=0)
        self.pool_address = nano_address_from_pubkey(self.pool_pub)
        self.rpc = NanoRPC()
        self.spent_nullifiers: set = set()
        self._load_state()

    def _state_path(self) -> str:
        return "data/guardian_state.json"

    def _load_state(self):
        if os.path.exists(self._state_path()):
            try:
                with open(self._state_path()) as f:
                    data = json.load(f)
                self.spent_nullifiers = set(bytes.fromhex(x) for x in data.get("nullifiers", []))
            except Exception as e:
                print("Guardian load state error:", e)

    def _save_state(self):
        os.makedirs("data", exist_ok=True)
        with open(self._state_path(), "w") as f:
            json.dump({"nullifiers": [x.hex() for x in self.spent_nullifiers]}, f)

    def _indexer_get(self, path: str) -> dict:
        resp = self.session.get(self.indexer_url + path, timeout=10)
        resp.raise_for_status()
        return resp.json()

    def _indexer_post(self, path: str, data: dict) -> dict:
        resp = self.session.post(self.indexer_url + path, json=data, timeout=10)
        resp.raise_for_status()
        return resp.json()

    def verify_withdrawal_request(self, req: dict) -> Optional[dict]:
        """
        Verify a withdrawal request.
        Prototype checks:
          - C is in the epoch Merkle tree.
          - N is not spent.
          - Source pubkey S_pub made a deposit to the pool.
          - Client signature over challenge proves ownership of S_pub.
        """
        try:
            n = bytes.fromhex(req["n"])
            t = bytes.fromhex(req["t"])
            P_w = bytes.fromhex(req["P_w"])
            S_pub = bytes.fromhex(req["S_pub"])
            C = bytes.fromhex(req["C"])
            epoch = int(req["epoch"])
            denomination = int(req["denomination"])
            deposit_hash = req["deposit_hash"]
            client_sig = bytes.fromhex(req["client_sig"])

            # Verify commitment
            expected_C = compute_commitment(n, t, P_w, S_pub)
            if C != expected_C:
                return None

            # Verify nullifier
            N = compute_nullifier(n)
            if N in self.spent_nullifiers:
                return None

            # Verify C in tree
            root = self._indexer_get(f"/root/{epoch}/{denomination}").get("root")
            if not root:
                return None
            root_bytes = bytes.fromhex(root)
            proof = self._indexer_get(f"/proof/{epoch}/{denomination}?C={C.hex()}")
            if not self._verify_merkle_proof(C, root_bytes, proof):
                return None

            # Verify source made deposit to pool
            dep_info = self.rpc.call("block_info", {"hash": deposit_hash, "json_block": "true"})
            dep_block = dep_info.get("contents", dep_info)
            if dep_block.get("account") != nano_address_from_pubkey(S_pub):
                return None
            if dep_block.get("link") != pool_pubkey(denomination).hex():
                return None
            amount = int(dep_info.get("amount", 0))
            if amount != denomination:
                return None

            # Verify client signature over challenge
            challenge = blake2b_256(N + P_w)
            if not verify_signature(S_pub, challenge, client_sig):
                return None

            return {
                "n": n,
                "P_w": P_w,
                "denomination": denomination,
                "N": N,
            }
        except Exception as e:
            print("verify withdrawal error:", e)
            return None

    def _verify_merkle_proof(self, C: bytes, root: bytes, proof: dict) -> bool:
        """Verify a Merkle proof against root."""
        path = [bytes.fromhex(x) for x in proof["path"]]
        indices = proof["indices"]
        current = hashlib.blake2b(C + bytes(32), digest_size=32).digest()
        for sibling, is_right in zip(path, indices):
            if is_right:
                current = hashlib.blake2b(sibling + current, digest_size=32).digest()
            else:
                current = hashlib.blake2b(current + sibling, digest_size=32).digest()
        return current == root

    def _get_account_info(self, address: str) -> dict:
        return self.rpc.call("account_info", {"account": address, "representative": "true"})

    def _broadcast_block(self, block: dict) -> dict:
        return self.rpc.call("process", {"json_block": "true", "block": block})

    def withdraw(self, req: dict) -> dict:
        verified = self.verify_withdrawal_request(req)
        if verified is None:
            return {"error": "verification failed"}

        denomination = verified["denomination"]
        P_w = verified["P_w"]
        N = verified["N"]

        # Build withdrawal send block from pool to P_w
        info = self._get_account_info(self.pool_address)
        if "error" in info:
            return {"error": f"pool account info failed: {info['error']}"}

        balance = int(info["balance"])
        if balance < denomination:
            return {"error": "insufficient pool balance"}

        previous = bytes.fromhex(info["frontier"])
        representative = bytes.fromhex(nano_pubkey_from_address(info["representative"]))
        new_balance = balance - (denomination - WITHDRAW_FEE_RAW)

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
            "work": "0000000000000000",  # PoW must be computed separately
        }

        # Nano RPC may require work; public nodes often don't accept process without valid PoW
        # For prototype, return the signed block; user can broadcast via own node or compute work
        self.spent_nullifiers.add(N)
        self._save_state()
        return {"ok": True, "block": block, "nullifier": N.hex()}


def create_app(guardian: VelaGuardian) -> Flask:
    app = Flask(__name__)

    @app.route("/")
    def health():
        return jsonify({"status": "ok", "pool_address": guardian.pool_address})

    @app.route("/pool_address")
    def pool_address():
        return jsonify({"address": guardian.pool_address})

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
