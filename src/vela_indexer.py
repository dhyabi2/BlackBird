"""
VELA v2 Indexer.

Tracks pool deposits and commitments, builds per-epoch Poseidon Merkle trees,
and serves roots/proofs to clients.

The production design runs multiple independent indexers whose roots are
expected to agree deterministically. Clients query several indexers and accept
a root only if a majority match. See DESIGN.md for the full architecture.
"""
import functools
import json
import os
import secrets
import tempfile
import threading
import time
from typing import Dict, List, Optional, Tuple

import requests
from flask import Flask, request, jsonify

from .vela_crypto import (
    pool_pubkey,
    pool_address,
    legacy_pool_pubkeys,
    nano_pubkey_from_address,
    compute_commitment,
    compute_nullifier,
)
from .work_service import WorkService, SEND_DIFFICULTY, RECEIVE_DIFFICULTY
from .poseidon_bridge import poseidon_tree, split32
from .snarkjs_bridge import generate_proof
from .nano_rpc import NanoRPC
from .vela_constants import EPOCH_SECONDS, FEE_BPS, DENOMINATIONS, MERKLE_DEPTH

GUARDIAN_URL = os.environ.get("VELA_GUARDIAN_URL", "http://127.0.0.1:8081")
_GUARDIAN_API_KEY = os.environ.get("VELA_API_KEY", "")


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

    def leaf_index(self, C: int) -> int:
        return self._leaf_index_map[C]


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
        """Atomically persist state with restricted permissions."""
        with self.lock:
            data = {
                "commitments": {
                    f"{epoch}:{denom}": [hex(x) for x in leaves]
                    for (epoch, denom), leaves in self.commitments.items()
                },
                "nullifiers": [x.hex() for x in self.nullifiers],
            }
            fd, tmp = tempfile.mkstemp(dir=self.data_dir, suffix=".tmp")
            try:
                with os.fdopen(fd, "w") as f:
                    json.dump(data, f)
                os.chmod(tmp, 0o600)
                os.replace(tmp, self._state_path())
            except Exception:
                try:
                    os.unlink(tmp)
                except Exception:
                    pass
                raise

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

    def leaf_index(self, epoch: int, denomination: int, C: int) -> Optional[int]:
        key = (epoch, denomination)
        with self.lock:
            if key not in self.trees:
                if key not in self.commitments:
                    return None
                self._rebuild_tree(key)
            try:
                return self.trees[key].leaf_index(C)
            except KeyError:
                return None

    def mark_nullifier(self, N: int):
        with self.lock:
            self.nullifiers.add(N)
        self._save_state()

    def is_nullifier_spent(self, N: int) -> bool:
        return N in self.nullifiers

    def verify_deposit_commitment_pair(self, deposit_hash: str, commit_hash: str) -> Optional[dict]:
        try:
            blocks = self.rpc.call("blocks_info", {
                "hashes": [deposit_hash, commit_hash],
                "json_block": "true",
            })
            dep = blocks["blocks"][deposit_hash]
            com = blocks["blocks"][commit_hash]

            dep_block = dep.get("contents", dep)
            com_block = com.get("contents", com)

            # Both must be state blocks (not legacy open/send/receive).
            if dep_block.get("type") != "state" or com_block.get("type") != "state":
                return None

            # Require on-chain confirmation before trusting block data.
            if dep.get("confirmed") != "true" or com.get("confirmed") != "true":
                return None

            if dep_block.get("account") != com_block.get("account"):
                return None

            amount_raw = int(dep.get("amount", 0))
            if amount_raw not in DENOMINATIONS:
                return None

            # Accept the current pool pubkey or any legacy (pre-migration)
            # pool pubkey: deposits made just before a key rotation may only
            # be indexed after it.
            dep_link = dep_block.get("link", "").lower()
            valid_pool_pubs = {pool_pubkey(amount_raw).hex().lower()}
            valid_pool_pubs.update(p.hex().lower() for p in legacy_pool_pubkeys(amount_raw))
            if dep_link not in valid_pool_pubs:
                return None

            # The commitment block must chain directly from the deposit block.
            if com_block.get("previous", "").lower() != deposit_hash.lower():
                return None

            # Commitment block sends exactly 1 raw to the commitment hash.
            if int(com.get("amount", 0)) != 1:
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


def pool_frontier_keeper(indexer: VelaIndexer, work_service: WorkService, interval: int = 15):
    """Keep send-difficulty work for every pool frontier permanently warmed.

    Pool frontiers are the only work roots known continuously in advance, so
    withdrawal work can always be served instantly from the cache.
    """
    while True:
        for denom in sorted(DENOMINATIONS):
            try:
                addr = pool_address(denom)
                info = indexer.rpc.call("account_info", {"account": addr})
                frontier = info.get("frontier")
                if frontier:
                    work_service.warm(frontier, SEND_DIFFICULTY)
            except Exception as e:
                print("pool frontier keeper error:", e)
        time.sleep(interval)


def create_app(indexer: VelaIndexer) -> Flask:
    app = Flask(__name__)
    work_service = WorkService()
    threading.Thread(
        target=pool_frontier_keeper, args=(indexer, work_service), daemon=True
    ).start()

    HEX64 = "0123456789abcdefABCDEF"

    def _valid_hex(s, length):
        return isinstance(s, str) and len(s) == length and all(c in HEX64 for c in s)

    @app.route("/api/work", methods=["POST"])
    @require_api_key
    def api_work():
        data = request.json or {}
        root = data.get("hash", "")
        difficulty = data.get("difficulty", SEND_DIFFICULTY)
        if not _valid_hex(root, 64) or not _valid_hex(difficulty, 16):
            return jsonify({"error": "invalid hash/difficulty"}), 400
        # Receive-difficulty work averages ~1.5s on this CPU, so compute it on
        # demand; send-difficulty averages ~95s, so serve it from cache only
        # (with a short grace period) and let the client fall back to local PoW.
        wait = 20.0 if difficulty.lower() == RECEIVE_DIFFICULTY else 3.0
        work = work_service.get_or_wait(root, difficulty, wait)
        if work:
            return jsonify({"work": work, "source": "server-cache"})
        return jsonify({"error": "work not ready", "queued": True}), 404

    @app.route("/api/work/warm", methods=["POST"])
    @require_api_key
    def api_work_warm():
        data = request.json or {}
        root = data.get("hash", "")
        difficulty = data.get("difficulty", SEND_DIFFICULTY)
        if not _valid_hex(root, 64) or not _valid_hex(difficulty, 16):
            return jsonify({"error": "invalid hash/difficulty"}), 400
        queued = work_service.warm(root, difficulty)
        return jsonify({"ok": True, "queued": queued, **work_service.stats()})

    @app.route("/")
    def health():
        return jsonify({"status": "ok", "epoch": indexer.current_epoch()})

    @app.route("/api/status")
    def api_status():
        epoch = indexer.current_epoch()
        roots = []
        for denom in sorted(DENOMINATIONS):
            root = indexer.get_root(epoch, denom)
            roots.append({
                "denomination": str(denom),
                "root": hex(root) if root else None,
            })
        return jsonify({
            "status": "ok",
            "epoch": epoch,
            "roots": roots,
            "pool_pubkey": pool_pubkey(10**30).hex(),
        })

    @app.route("/api/deposit", methods=["POST"])
    @require_api_key
    def api_deposit():
        data = request.json or {}
        result = indexer.verify_deposit_commitment_pair(
            data.get("deposit_hash"), data.get("commit_hash")
        )
        if result is None:
            return jsonify({"error": "invalid deposit/commit pair"}), 400
        indexer.add_commitment(result["epoch"], result["denomination"], int(result["commitment"], 16))
        return jsonify({"ok": True, "commitment": result["commitment"], "epoch": result["epoch"]})

    @app.route("/api/deposit_status", methods=["GET", "POST"])
    @require_api_key
    def api_deposit_status():
        data = request.args if request.method == "GET" else (request.json or {})
        C: Optional[int] = None
        epoch: Optional[int] = None
        denomination: Optional[int] = None

        deposit_hash = data.get("deposit_hash")
        commit_hash = data.get("commit_hash")
        C_hex = data.get("commitment")

        if deposit_hash and commit_hash:
            pair = indexer.verify_deposit_commitment_pair(deposit_hash, commit_hash)
            if pair is None:
                return jsonify({"error": "invalid deposit/commit pair"}), 400
            C = int(pair["commitment"], 16)
            epoch = pair["epoch"]
            denomination = pair["denomination"]
        elif C_hex:
            try:
                C = int(C_hex, 16)
            except Exception:
                return jsonify({"error": "invalid commitment"}), 400
            for (e, d), leaves in indexer.commitments.items():
                if C in leaves:
                    epoch = e
                    denomination = d
                    break
        else:
            return jsonify({"error": "missing deposit_hash+commit_hash or commitment"}), 400

        if C is None or epoch is None or denomination is None:
            return jsonify({"indexed": False}), 200

        root = indexer.get_root(epoch, denomination)
        proof_info = indexer.get_proof(epoch, denomination, C)
        return jsonify({
            "indexed": proof_info is not None,
            "commitment": hex(C),
            "epoch": epoch,
            "denomination": denomination,
            "root": hex(root) if root else None,
            "leaf_index": indexer.leaf_index(epoch, denomination, C),
        })

    @app.route("/api/nullifier/<nullifier_hex>")
    @require_api_key
    def api_nullifier_status(nullifier_hex):
        headers = {"X-VELA-API-Key": _GUARDIAN_API_KEY} if _GUARDIAN_API_KEY else {}
        resp = requests.get(f"{GUARDIAN_URL}/nullifier/{nullifier_hex}", headers=headers, timeout=10)
        try:
            body = resp.json()
        except Exception:
            body = {"error": resp.text}
        if not resp.ok:
            return jsonify(body), resp.status_code
        return jsonify(body)

    @app.route("/api/withdraw", methods=["POST"])
    @require_api_key
    def api_withdraw():
        data = request.json or {}
        try:
            destination = data["destination"]
            P_w = nano_pubkey_from_address(destination)
            guardian_req = {
                "epoch": int(data["epoch"]),
                "denomination": int(data["denomination"]),
                "P_w": P_w.hex(),
                "nullifier": data["nullifier"],
                "proof": data["proof"],
                "publicSignals": data["publicSignals"],
            }
            headers = {"X-VELA-API-Key": _GUARDIAN_API_KEY} if _GUARDIAN_API_KEY else {}
            resp = requests.post(f"{GUARDIAN_URL}/withdraw", json=guardian_req, headers=headers, timeout=30)
            try:
                body = resp.json()
            except Exception:
                body = {"error": resp.text}
            if not resp.ok:
                return jsonify(body), resp.status_code
            return jsonify(body)
        except Exception as e:
            return jsonify({"error": str(e)}), 400

    @app.route("/api/broadcast_withdrawal", methods=["POST"])
    @require_api_key
    def api_broadcast_withdrawal():
        data = request.json or {}
        headers = {"X-VELA-API-Key": _GUARDIAN_API_KEY} if _GUARDIAN_API_KEY else {}
        resp = requests.post(f"{GUARDIAN_URL}/broadcast_withdrawal", json=data, headers=headers, timeout=30)
        try:
            body = resp.json()
        except Exception:
            body = {"error": resp.text}
        if not resp.ok:
            return jsonify(body), resp.status_code
        return jsonify(body)

    @app.route("/api/prove", methods=["POST"])
    @require_api_key
    def api_prove():
        data = request.json or {}
        try:
            n = bytes.fromhex(data["n"])
            t = bytes.fromhex(data["t"])
            P_w = bytes.fromhex(data["P_w"])
            denomination = int(data["denomination"])
            epoch = int(data["epoch"])
            if len(n) != 32 or len(t) != 32 or len(P_w) != 32:
                return jsonify({"error": "n, t, P_w must be 32 bytes"}), 400

            if denomination not in DENOMINATIONS:
                return jsonify({"error": "unsupported denomination"}), 400

            # Deposits bind the pool pubkey that was current when they were
            # made. Try the current key first, then any legacy keys, so
            # commitments created before a key rotation stay provable.
            S_pub = None
            proof_info = None
            candidates = [pool_pubkey(denomination)] + legacy_pool_pubkeys(denomination)
            for cand in candidates:
                C = compute_commitment(n, t, P_w, cand)
                proof_info = indexer.get_proof(epoch, denomination, C)
                if proof_info is not None:
                    S_pub = cand
                    break
            if proof_info is None:
                return jsonify({"error": "commitment not in tree"}), 404

            path = [int(x) for x in proof_info["path"]]
            indices = [int(x) for x in proof_info["indices"]]
            if len(path) != MERKLE_DEPTH or len(indices) != MERKLE_DEPTH:
                return jsonify({"error": "invalid proof depth"}), 500

            n_lo, n_hi = split32(n)
            t_lo, t_hi = split32(t)
            P_w_lo, P_w_hi = split32(P_w)
            S_pub_lo, S_pub_hi = split32(S_pub)
            root = indexer.get_root(epoch, denomination)
            if root is None:
                return jsonify({"error": "no tree for epoch/denomination"}), 404
            N = int(data["nullifier"], 16) if data.get("nullifier") else compute_nullifier(n)

            input_signals = {
                "root": root,
                "nullifier": N,
                "P_w_lo": P_w_lo,
                "P_w_hi": P_w_hi,
                "n_lo": n_lo,
                "n_hi": n_hi,
                "t_lo": t_lo,
                "t_hi": t_hi,
                "S_pub_lo": S_pub_lo,
                "S_pub_hi": S_pub_hi,
                "leafIndex": indices,
                "path": path,
            }
            result = generate_proof(input_signals)
            return jsonify(result)
        except Exception as e:
            print("prove error:", e)
            return jsonify({"error": str(e)}), 400

    @app.route("/api/fee")
    def api_fee():
        return jsonify({"fee_bps": FEE_BPS, "fee_percent": FEE_BPS / 100})

    @app.route("/api/pool_address/<int:denomination>")
    def api_pool_address(denomination):
        pub = pool_pubkey(denomination)
        return jsonify({
            "denomination": str(denomination),
            "pool_pubkey": pub.hex(),
            # Pre-migration pool pubkeys: commitments deposited under an old
            # key still reference it, so clients must try these when matching.
            "legacy_pubkeys": [p.hex() for p in legacy_pool_pubkeys(denomination)],
        })

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
    @require_api_key
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
