"""
VELA v2 Indexer (prototype).

Tracks pool deposits and commitments, builds per-epoch Merkle trees,
and serves roots/proofs to clients.

NOTE: This prototype uses Blake2b for the Merkle tree instead of Poseidon
and does not perform true ZK verification. The guardian sees the source
public key. A production deployment must integrate the Circom circuit.
"""

import hashlib
import json
import os
import threading
import time
from typing import Dict, List, Optional, Tuple

import requests
from flask import Flask, request, jsonify

from .vela_crypto import (
    pool_pubkey,
)

EPOCH_SECONDS = 86400
DENOMINATIONS = {10**29, 10**30, 10**31, 10**32}
MERKLE_DEPTH = 20

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


class MerkleTree:
    """Merkle tree using Blake2b (prototype; production uses Poseidon)."""

    def __init__(self, leaves: List[bytes], depth: int = MERKLE_DEPTH):
        self.depth = depth
        self.leaves = sorted(set(leaves))
        self.size = 2 ** depth
        self.leaves += [bytes(32)] * (self.size - len(self.leaves))
        self.zeros = self._build_zeros()
        self.root, self.tree = self._build_tree()

    def _hash(self, a: bytes, b: bytes) -> bytes:
        if a > b:
            a, b = b, a
        return hashlib.blake2b(a + b, digest_size=32).digest()

    def _build_zeros(self) -> List[bytes]:
        zeros = [bytes(32)]
        for _ in range(self.depth):
            zeros.append(self._hash(zeros[-1], zeros[-1]))
        return zeros

    def _build_tree(self) -> Tuple[bytes, List[List[bytes]]]:
        tree = [self.leaves]
        current = self.leaves[:]
        for level in range(self.depth):
            next_level = []
            for i in range(0, len(current), 2):
                left = current[i]
                right = current[i + 1] if i + 1 < len(current) else self.zeros[level]
                next_level.append(self._hash(left, right))
            tree.append(next_level)
            current = next_level
        return current[0], tree

    def get_proof(self, leaf: bytes) -> Tuple[List[bytes], List[int]]:
        idx = self.leaves.index(leaf)
        path = []
        indices = []
        for level in range(self.depth):
            sibling_idx = idx ^ 1
            sibling = self.tree[level][sibling_idx] if sibling_idx < len(self.tree[level]) else self.zeros[level]
            path.append(sibling)
            indices.append(idx % 2)
            idx //= 2
        return path, indices


class VelaIndexer:
    def __init__(self, data_dir: str = "data"):
        self.data_dir = data_dir
        os.makedirs(data_dir, exist_ok=True)
        self.rpc = NanoRPC()
        self.commitments: Dict[Tuple[int, int], set] = {}
        self.trees: Dict[Tuple[int, int], MerkleTree] = {}
        self.nullifiers: set = set()
        self.lock = threading.Lock()
        self._load_state()

    def _state_path(self) -> str:
        return os.path.join(self.data_dir, "indexer_state.json")

    def _load_state(self):
        path = self._state_path()
        if os.path.exists(path):
            try:
                with open(path) as f:
                    data = json.load(f)
                for k, v in data.get("commitments", {}).items():
                    epoch, denom = map(int, k.split(":"))
                    self.commitments[(epoch, denom)] = set(bytes.fromhex(x) for x in v)
                self.nullifiers = set(bytes.fromhex(x) for x in data.get("nullifiers", []))
            except Exception as e:
                print("Failed to load state:", e)

    def _save_state(self):
        with self.lock:
            data = {
                "commitments": {
                    f"{epoch}:{denom}": [x.hex() for x in leaves]
                    for (epoch, denom), leaves in self.commitments.items()
                },
                "nullifiers": [x.hex() for x in self.nullifiers],
            }
            with open(self._state_path(), "w") as f:
                json.dump(data, f)

    def current_epoch(self) -> int:
        return int(time.time()) // EPOCH_SECONDS

    def add_commitment(self, epoch: int, denomination: int, C: bytes):
        with self.lock:
            key = (epoch, denomination)
            self.commitments.setdefault(key, set()).add(C)
            self._rebuild_tree(key)
        self._save_state()

    def _rebuild_tree(self, key: Tuple[int, int]):
        leaves = list(self.commitments.get(key, []))
        self.trees[key] = MerkleTree(leaves)

    def get_root(self, epoch: int, denomination: int) -> Optional[bytes]:
        key = (epoch, denomination)
        with self.lock:
            if key not in self.trees:
                if key not in self.commitments:
                    return None
                self._rebuild_tree(key)
            return self.trees[key].root

    def get_proof(self, epoch: int, denomination: int, C: bytes) -> Optional[dict]:
        key = (epoch, denomination)
        with self.lock:
            if key not in self.trees:
                if key not in self.commitments:
                    return None
                self._rebuild_tree(key)
            try:
                path, indices = self.trees[key].get_proof(C)
            except ValueError:
                return None
        return {
            "path": [x.hex() for x in path],
            "indices": indices,
        }

    def mark_nullifier(self, N: bytes):
        with self.lock:
            self.nullifiers.add(N)
        self._save_state()

    def is_nullifier_spent(self, N: bytes) -> bool:
        return N in self.nullifiers

    def verify_deposit_commitment_pair(self, deposit_hash: str, commit_hash: str) -> Optional[dict]:
        try:
            blocks = self.rpc.call("blocks_info", {
                "hashes": json.dumps([deposit_hash, commit_hash]),
                "json_block": "true",
            })
            dep = blocks["blocks"][deposit_hash]
            com = blocks["blocks"][commit_hash]

            dep_block = dep.get("contents", dep)
            com_block = com.get("contents", com)

            if dep_block.get("account") != com_block.get("account"):
                return None

            amount_raw = int(dep.get("amount", 0))
            if amount_raw not in DENOMINATIONS:
                return None

            if dep_block.get("link") != pool_pubkey(amount_raw).hex():
                return None

            C = bytes.fromhex(com_block.get("link", ""))
            if len(C) != 32:
                return None

            epoch = int(dep.get("local_timestamp", time.time())) // EPOCH_SECONDS
            return {
                "source": dep_block["account"],
                "denomination": amount_raw,
                "epoch": epoch,
                "commitment": C.hex(),
            }
        except Exception as e:
            print("verify pair error:", e)
            return None


def create_app(indexer: VelaIndexer) -> Flask:
    app = Flask(__name__)

    @app.route("/")
    def health():
        return jsonify({"status": "ok", "epoch": indexer.current_epoch()})

    @app.route("/root/<int:epoch>/<int:denomination>")
    def root(epoch, denomination):
        r = indexer.get_root(epoch, denomination)
        if r is None:
            return jsonify({"error": "no tree"}), 404
        return jsonify({"root": r.hex(), "epoch": epoch, "denomination": denomination})

    @app.route("/proof/<int:epoch>/<int:denomination>")
    def proof(epoch, denomination):
        C = request.args.get("C", "")
        try:
            C_bytes = bytes.fromhex(C)
        except Exception:
            return jsonify({"error": "invalid C"}), 400
        p = indexer.get_proof(epoch, denomination, C_bytes)
        if p is None:
            return jsonify({"error": "proof not found"}), 404
        return jsonify(p)

    @app.route("/submit", methods=["POST"])
    def submit():
        data = request.json or {}
        result = indexer.verify_deposit_commitment_pair(data.get("deposit_hash"), data.get("commit_hash"))
        if result is None:
            return jsonify({"error": "invalid pair"}), 400
        indexer.add_commitment(result["epoch"], result["denomination"], bytes.fromhex(result["commitment"]))
        return jsonify({"ok": True, "commitment": result["commitment"]})

    @app.route("/nullifier_spent")
    def nullifier_spent():
        N = request.args.get("N", "")
        try:
            N_bytes = bytes.fromhex(N)
        except Exception:
            return jsonify({"error": "invalid N"}), 400
        return jsonify({"spent": indexer.is_nullifier_spent(N_bytes)})

    return app


if __name__ == "__main__":
    from waitress import serve
    indexer = VelaIndexer()
    app = create_app(indexer)
    serve(app, host="127.0.0.1", port=8080)
