"""
VELA v2 Indexer.

Tracks pool deposits and commitments, builds per-epoch Poseidon Merkle trees,
and serves roots/proofs to clients.

The production design runs multiple independent indexers whose roots are
expected to agree deterministically. Clients query several indexers and accept
a root only if a majority match. See DESIGN.md for the full architecture.
"""
import json
import os
import threading
import time
from typing import Dict, List, Optional, Tuple

import requests
from flask import Flask, request, jsonify

from .vela_crypto import pool_pubkey
from .poseidon_bridge import poseidon_tree
from .nano_rpc import NanoRPC

EPOCH_SECONDS = 86400
DENOMINATIONS = {10**29, 10**30, 10**31, 10**32}
MERKLE_DEPTH = 20


class PoseidonMerkleTree:
    """Merkle tree using Poseidon (matches circuit/vela.circom)."""

    def __init__(self, commitments: List[int], depth: int = MERKLE_DEPTH):
        self.depth = depth
        self.commitments = sorted(set(commitments))
        result = poseidon_tree(self.commitments, depth, leaf_index=0)
        self.root = int(result["root"])
        self._leaf_index_map = {C: i for i, C in enumerate(self.commitments)}

    def get_proof(self, C: int) -> Tuple[List[int], List[int]]:
        if C not in self._leaf_index_map:
            raise ValueError("leaf not found")
        idx = self._leaf_index_map[C]
        result = poseidon_tree(self.commitments, self.depth, idx)
        path = [int(x) for x in result["path"]]
        indices = result["indices"]
        return path, indices


class VelaIndexer:
    def __init__(self, data_dir: str = "data"):
        self.data_dir = data_dir
        os.makedirs(data_dir, exist_ok=True)
        self.rpc = NanoRPC()
        self.commitments: Dict[Tuple[int, int], set] = {}
        self.trees: Dict[Tuple[int, int], PoseidonMerkleTree] = {}
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
                    self.commitments[(epoch, denom)] = set(int(x, 16) for x in v)
                self.nullifiers = set(bytes.fromhex(x) for x in data.get("nullifiers", []))
            except Exception as e:
                print("Failed to load state:", e)

    def _save_state(self):
        with self.lock:
            data = {
                "commitments": {
                    f"{epoch}:{denom}": [hex(x) for x in leaves]
                    for (epoch, denom), leaves in self.commitments.items()
                },
                "nullifiers": [x.hex() for x in self.nullifiers],
            }
            with open(self._state_path(), "w") as f:
                json.dump(data, f)

    def current_epoch(self) -> int:
        return int(time.time()) // EPOCH_SECONDS

    def add_commitment(self, epoch: int, denomination: int, C: int):
        with self.lock:
            key = (epoch, denomination)
            self.commitments.setdefault(key, set()).add(C)
            self._rebuild_tree(key)
        self._save_state()

    def _rebuild_tree(self, key: Tuple[int, int]):
        leaves = list(self.commitments.get(key, []))
        self.trees[key] = PoseidonMerkleTree(leaves)

    def get_root(self, epoch: int, denomination: int) -> Optional[int]:
        key = (epoch, denomination)
        with self.lock:
            if key not in self.trees:
                if key not in self.commitments:
                    return None
                self._rebuild_tree(key)
            return self.trees[key].root

    def get_proof(self, epoch: int, denomination: int, C: int) -> Optional[dict]:
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
            "path": [str(x) for x in path],
            "indices": indices,
        }

    def mark_nullifier(self, N: int):
        with self.lock:
            self.nullifiers.add(N)
        self._save_state()

    def is_nullifier_spent(self, N: int) -> bool:
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

            C_bytes = bytes.fromhex(com_block.get("link", ""))
            if len(C_bytes) != 32:
                return None
            C = int.from_bytes(C_bytes, "big")

            epoch = int(dep.get("local_timestamp", time.time())) // EPOCH_SECONDS
            return {
                "source": dep_block["account"],
                "denomination": amount_raw,
                "epoch": epoch,
                "commitment": hex(C),
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
        return jsonify({"root": hex(r), "epoch": epoch, "denomination": denomination})

    @app.route("/proof/<int:epoch>/<int:denomination>")
    def proof(epoch, denomination):
        C_hex = request.args.get("C", "")
        try:
            C = int(C_hex, 16)
        except Exception:
            return jsonify({"error": "invalid C"}), 400
        p = indexer.get_proof(epoch, denomination, C)
        if p is None:
            return jsonify({"error": "proof not found"}), 404
        return jsonify(p)

    @app.route("/submit", methods=["POST"])
    def submit():
        data = request.json or {}
        result = indexer.verify_deposit_commitment_pair(data.get("deposit_hash"), data.get("commit_hash"))
        if result is None:
            return jsonify({"error": "invalid pair"}), 400
        indexer.add_commitment(result["epoch"], result["denomination"], int(result["commitment"], 16))
        return jsonify({"ok": True, "commitment": result["commitment"]})

    @app.route("/nullifier_spent")
    def nullifier_spent():
        N_hex = request.args.get("N", "")
        try:
            N = int(N_hex, 16)
        except Exception:
            return jsonify({"error": "invalid N"}), 400
        return jsonify({"spent": indexer.is_nullifier_spent(N)})

    return app


if __name__ == "__main__":
    from waitress import serve
    indexer = VelaIndexer()
    app = create_app(indexer)
    serve(app, host="127.0.0.1", port=8080)
