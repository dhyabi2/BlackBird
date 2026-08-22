"""
VELA v2 Guardian (coordinator).

Verifies Groth16 ZK withdrawal proofs and signs/broadcasts pool blocks.
Signing is 2-of-3 FROST threshold: this coordinator holds one key share and
runs the two-round ceremony with a verifying cosigner (src/vela_cosigner.py)
on another machine — no single machine controls the pool key. Denominations
not yet migrated to threshold custody fall back to the legacy seed-derived
single key. See DESIGN.md for the full architecture.
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
    pool_pubkey,
    nano_pubkey_from_address,
    nano_address_from_pubkey,
    nano_state_block_hash,
    nullifier_anchor_keypair,
    sign_message,
)
from .frost_signer import FrostSigner, frost_enabled
from .poseidon_bridge import split32
from .snarkjs_bridge import verify_proof
from .nano_rpc import NanoRPC
from .vela_constants import EPOCH_SECONDS, FEE_BPS, DENOMINATIONS


def withdraw_fee_for(denomination: int) -> int:
    """Return the guardian fee in raw for a given denomination.

    Fee is 0% (0 basis points) of the denomination.
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
        # Nullifiers that have been signed but not yet broadcast.
        self.pending_withdrawals: dict = {}
        # Spent nullifiers not yet anchored on-chain (see nullifier_anchor_loop).
        self.unanchored_nullifiers: set = set()
        self._lock = threading.Lock()
        self._frost_signers: dict = {}
        self.anchor_sk, self.anchor_pub = nullifier_anchor_keypair(seed)
        self.anchor_address = nano_address_from_pubkey(self.anchor_pub)
        self._load_state()
        print(f"nullifier anchor account: {self.anchor_address} "
              f"(fund with a little XNO to activate on-chain anchoring; 1 raw per withdrawal)")

    def _frost_signer(self, denomination: int) -> FrostSigner:
        signer = self._frost_signers.get(denomination)
        if signer is None:
            signer = FrostSigner(denomination)
            self._frost_signers[denomination] = signer
        return signer

    def _sign_pool_block(self, denomination: int, block_hash: bytes, context: dict) -> bytes:
        """Sign a pool state block hash: 2-of-3 FROST for migrated
        denominations, the legacy single key otherwise."""
        if frost_enabled(denomination):
            return self._frost_signer(denomination).sign(block_hash, context)
        pool_sk, _ = pool_keypair(denomination, self.seed)
        return sign_message(pool_sk, block_hash)

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
                self.pending_withdrawals = {
                    int(k, 16): v for k, v in data.get("pending", {}).items()
                }
                if "unanchored" in data:
                    self.unanchored_nullifiers = set(int(x, 16) for x in data["unanchored"])
                else:
                    # First run with anchoring: backfill every known spent
                    # nullifier so history gets anchored once the account is funded.
                    self.unanchored_nullifiers = set(self.spent_nullifiers)
            except Exception as e:
                print("Guardian load state error:", e)

    def _save_state(self):
        """Atomically persist state with restricted permissions."""
        os.makedirs(self.data_dir, exist_ok=True)
        path = self._state_path()
        fd, tmp = tempfile.mkstemp(dir=self.data_dir, suffix=".tmp")
        try:
            with os.fdopen(fd, "w") as f:
                state = {
                    "nullifiers": [hex(x) for x in self.spent_nullifiers],
                    "unanchored": [hex(x) for x in self.unanchored_nullifiers],
                    "pending": {
                        hex(k): v for k, v in self.pending_withdrawals.items()
                    },
                }
                json.dump(state, f)
            os.chmod(tmp, 0o600)
            os.replace(tmp, path)
        except Exception:
            try:
                os.unlink(tmp)
            except Exception:
                pass
            raise

    RECEIVE_THRESHOLD = 0xFFFFFE0000000000
    SEND_THRESHOLD = 0xFFFFFFF800000000
    ZERO_32 = b"\x00" * 32

    def _generate_work(self, root: bytes, threshold: int) -> str:
        """Proof-of-work at the given threshold.

        Primary: the remote RPC work service (validated locally). Fallback:
        CPU search. Returns the 16-char big-endian hex work value; the hash
        input uses the little-endian byte order per the protocol.
        """
        import hashlib

        from .work_service import validate_work

        diff_hex = format(threshold, "016x")
        try:
            result = self.rpc.call("work_generate", {
                "hash": root.hex(), "difficulty": diff_hex,
            })
            work = (result.get("work") or "").strip()
            if work and validate_work(work, root.hex(), diff_hex):
                return work
        except Exception as e:
            print("work via RPC failed, falling back to CPU:", e)

        value = int.from_bytes(secrets.token_bytes(8), "little")
        while True:
            wb = value.to_bytes(8, "little")
            digest = hashlib.blake2b(wb + root, digest_size=8).digest()
            if int.from_bytes(digest, "little") >= threshold:
                return value.to_bytes(8, "big").hex()
            value = (value + 1) & 0xFFFFFFFFFFFFFFFF

    def _generate_receive_work(self, root: bytes) -> str:
        return self._generate_work(root, self.RECEIVE_THRESHOLD)

    def receive_pool_pending(self, denomination: int, max_blocks: int = 20) -> int:
        """Receive pending sends into the pool account for a denomination.

        Deposits arrive as receivable blocks; the pool account must receive
        them before the guardian can sign withdrawals. Returns the number of
        receive blocks broadcast.
        """
        pool_pub = pool_pubkey(denomination, self.seed)
        addr = pool_address(denomination, self.seed)

        pending = self.rpc.call("receivable", {"account": addr, "count": str(max_blocks), "source": "true"})
        blocks = pending.get("blocks") or {}
        if not blocks:
            return 0

        info = self._get_account_info(addr)
        if info.get("error") == "Account not found":
            previous = self.ZERO_32
            balance = 0
            rep_addr = addr
            rep_pub = pool_pub
        elif "error" in info:
            print("pool receive: account_info error:", info["error"])
            return 0
        else:
            previous = bytes.fromhex(info["frontier"])
            balance = int(info["balance"])
            rep_addr = info["representative"]
            rep_pub = nano_pubkey_from_address(rep_addr)

        received = 0
        for send_hash, meta in blocks.items():
            amount = int(meta["amount"] if isinstance(meta, dict) else meta)
            new_balance = balance + amount
            link = bytes.fromhex(send_hash)
            block_hash = nano_state_block_hash(pool_pub, previous, rep_pub, new_balance, link)
            block_fields = {
                "type": "state",
                "account": addr,
                "previous": previous.hex(),
                "representative": rep_addr,
                "balance": str(new_balance),
                "link": send_hash,
            }
            try:
                signature = self._sign_pool_block(
                    denomination, block_hash, {"type": "receive", "block": block_fields}
                )
            except Exception as e:
                print("pool receive: signing failed:", e)
                break
            work_root = pool_pub if previous == self.ZERO_32 else previous
            work = self._generate_receive_work(work_root)
            block = {**block_fields, "signature": signature.hex(), "work": work}
            result = self.rpc.call("process", {"json_block": "true", "subtype": "receive", "block": block})
            if result.get("error"):
                print("pool receive: broadcast rejected:", result["error"])
                break
            print(f"pool receive: {addr} received {amount} raw ({result.get('hash')})")
            previous = block_hash
            balance = new_balance
            received += 1
            self._warm_frontier_work(block_hash.hex())
        return received

    def pool_receive_loop(self, interval: int = 30):
        """Background sweep: keep pool accounts' pending deposits received."""
        while True:
            for denom in sorted(DENOMINATIONS):
                try:
                    self.receive_pool_pending(denom)
                except Exception as e:
                    print("pool receive loop error:", e)
            time.sleep(interval)

    # ------------------------------------------------------------------
    # Nullifier anchoring (pattern from the holdergame trustless roadmap):
    # the spent-nullifier set is the ONLY custody state not derivable from
    # chain data — losing it allows double-spends. Each spent nullifier is
    # therefore anchored on-chain as a 1-raw send from a dedicated anchor
    # account whose link IS the nullifier. scripts/rebuild_indexer.py
    # recovers the set from the anchor account's chain (boot-from-nothing).
    # Dormant until the anchor account is funded; withdrawals never wait on it.
    # ------------------------------------------------------------------

    def _anchor_receive_pending(self, previous: bytes, balance: int, rep_addr: str) -> tuple:
        """Receive any funding sent to the anchor account. Returns the updated
        (previous, balance, rep_addr)."""
        pending = self.rpc.call("receivable", {"account": self.anchor_address, "count": "10", "source": "true"})
        blocks = pending.get("blocks") or {}
        if not isinstance(blocks, dict):
            return previous, balance, rep_addr
        for send_hash, meta in blocks.items():
            amount = int(meta["amount"] if isinstance(meta, dict) else meta)
            new_balance = balance + amount
            is_open = previous == self.ZERO_32
            rep = self.anchor_address if is_open else rep_addr
            rep_pub = nano_pubkey_from_address(rep)
            block_hash = nano_state_block_hash(
                self.anchor_pub, previous, rep_pub, new_balance, bytes.fromhex(send_hash)
            )
            work_root = self.anchor_pub if is_open else previous
            block = {
                "type": "state",
                "account": self.anchor_address,
                "previous": previous.hex(),
                "representative": rep,
                "balance": str(new_balance),
                "link": send_hash,
                "signature": self.anchor_sk.sign(block_hash).hex(),
                "work": self._generate_work(work_root, self.RECEIVE_THRESHOLD),
            }
            result = self.rpc.call("process", {"json_block": "true", "subtype": "receive", "block": block})
            if result.get("error"):
                print("anchor receive rejected:", result["error"])
                break
            previous, balance, rep_addr = block_hash, new_balance, rep
            print(f"anchor account received {amount} raw ({result.get('hash')})")
        return previous, balance, rep_addr

    def anchor_pending_nullifiers(self, max_per_pass: int = 10) -> int:
        """Anchor queued nullifiers on-chain. Returns how many were anchored."""
        with self._lock:
            queue = sorted(self.unanchored_nullifiers)[:max_per_pass]
        info = self._get_account_info(self.anchor_address)
        if info.get("error") == "Account not found":
            previous, balance, rep_addr = self.ZERO_32, 0, self.anchor_address
        elif "error" in info:
            print("anchor: account_info error:", info["error"])
            return 0
        else:
            previous = bytes.fromhex(info["frontier"])
            balance = int(info["balance"])
            rep_addr = info["representative"]

        previous, balance, rep_addr = self._anchor_receive_pending(previous, balance, rep_addr)
        if not queue:
            return 0
        if previous == self.ZERO_32 or balance < 1:
            return 0  # dormant until funded

        anchored = 0
        rep_pub = nano_pubkey_from_address(rep_addr)
        for N in queue:
            if balance < 1:
                print("anchor account out of funds; top it up to resume anchoring")
                break
            link = N.to_bytes(32, "big")
            new_balance = balance - 1
            block_hash = nano_state_block_hash(self.anchor_pub, previous, rep_pub, new_balance, link)
            block = {
                "type": "state",
                "account": self.anchor_address,
                "previous": previous.hex(),
                "representative": rep_addr,
                "balance": str(new_balance),
                "link": link.hex(),
                "signature": self.anchor_sk.sign(block_hash).hex(),
                "work": self._generate_work(previous, self.SEND_THRESHOLD),
            }
            result = self.rpc.call("process", {"json_block": "true", "subtype": "send", "block": block})
            if result.get("error"):
                print("anchor send rejected:", result["error"])
                break
            previous, balance = block_hash, new_balance
            with self._lock:
                self.unanchored_nullifiers.discard(N)
            self._save_state()
            anchored += 1
            print(f"anchored nullifier {hex(N)[:18]}... ({result.get('hash')})")
        return anchored

    def nullifier_anchor_loop(self, interval: int = 60):
        while True:
            try:
                self.anchor_pending_nullifiers()
            except Exception as e:
                print("nullifier anchor loop error:", e)
            time.sleep(interval)

    def _indexer_get(self, path: str) -> dict:
        resp = self.session.get(self.indexer_url + path, timeout=10)
        resp.raise_for_status()
        return resp.json()

    def _warm_frontier_work(self, root_hex: str):
        """Ask the indexer work service to precompute send work for a new pool
        frontier. Every pool block moves the frontier, so warming immediately
        keeps withdrawal work a cache hit."""
        try:
            self.session.post(
                self.indexer_url + "/api/work/warm",
                json={"hash": root_hex, "difficulty": "fffffff800000000"},
                headers={"X-VELA-API-Key": os.environ.get("VELA_API_KEY", "")},
                timeout=3,
            )
        except Exception:
            pass

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

        pool_pub = pool_pubkey(denomination, self.seed)
        pool_addr = pool_address(denomination, self.seed)

        # Fetch pool account info outside the lock. If the pool account is
        # unopened or short on balance, receive pending deposits first.
        info = self._get_account_info(pool_addr)
        if info.get("error") == "Account not found" or (
            "error" not in info and int(info["balance"]) < denomination - withdraw_fee_for(denomination)
        ):
            try:
                self.receive_pool_pending(denomination)
            except Exception as e:
                print("pool receive before withdraw failed:", e)
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

            # If we already signed this withdrawal, return the same signed block
            # so the client can attach work and broadcast it — but only while
            # the pool frontier has not moved. If another pool block landed in
            # the meantime, the old block would be rejected as a Fork, so drop
            # it and re-sign against the current frontier below.
            if N in self.pending_withdrawals:
                pending = self.pending_withdrawals[N]
                if str(pending["block"].get("previous", "")).lower() == previous.hex().lower():
                    return {
                        "ok": True,
                        "block": pending["block"],
                        "block_hash": pending["block_hash"],
                        "nullifier": hex(N),
                        "fee_raw": pending["fee_raw"],
                        "send_amount_raw": pending["send_amount_raw"],
                        "pending": True,
                    }
                print(f"withdraw: pool frontier moved; re-signing withdrawal for nullifier {hex(N)[:18]}...")
                self.pending_withdrawals.pop(N, None)

            block_hash = nano_state_block_hash(
                pool_pub,
                previous,
                representative,
                new_balance,
                P_w,
            )
            block_fields = {
                "type": "state",
                "account": pool_addr,
                "previous": previous.hex(),
                "representative": info["representative"],
                "balance": str(new_balance),
                "link": P_w.hex(),
            }
            try:
                signature = self._sign_pool_block(
                    denomination,
                    block_hash,
                    {"type": "withdraw", "block": block_fields, "request": req},
                )
            except Exception as e:
                print("withdraw: signing failed:", e)
                return {"error": f"signing failed: {e}"}

            block = {**block_fields, "signature": signature.hex(), "work": "0000000000000000"}

            self.pending_withdrawals[N] = {
                "block": block,
                "block_hash": block_hash.hex(),
                "fee_raw": fee_raw,
                "send_amount_raw": send_amount,
                "created_at": time.time(),
            }
            self._save_state()

        return {
            "ok": True,
            "block": block,
            "block_hash": block_hash.hex(),
            "nullifier": hex(N),
            "fee_raw": fee_raw,
            "send_amount_raw": send_amount,
            "pending": True,
        }

    def broadcast_withdrawal(self, req: dict) -> dict:
        """Broadcast a signed withdrawal block and mark the nullifier spent on success."""
        try:
            N = int(req["nullifier"], 16)
            block = req["block"]
        except Exception:
            return {"error": "invalid request"}

        with self._lock:
            if N in self.spent_nullifiers:
                return {"error": "nullifier already spent"}

            pending = self.pending_withdrawals.get(N)
            if not pending:
                return {"error": "withdrawal not signed"}

            # Verify the provided block is the one we signed (work may differ).
            signed = pending["block"]
            for field in ("type", "account", "previous", "representative", "balance", "link", "signature"):
                if block.get(field) != signed.get(field):
                    return {"error": f"block field mismatch: {field}"}

            if block.get("work") == "0000000000000000":
                return {"error": "block work not set"}

            # Broadcast via the Nano RPC.
            try:
                result = self._broadcast_block(block)
            except Exception as e:
                return {"error": f"broadcast failed: {e}"}

            if result.get("error"):
                return {"error": f"broadcast rejected: {result['error']}"}

            # Only mark spent after a successful broadcast.
            self.spent_nullifiers.add(N)
            # Queue the on-chain anchor (nullifier_anchor_loop drains this);
            # never blocks or fails the withdrawal itself.
            self.unanchored_nullifiers.add(N)
            broadcast_hash = pending.get("block_hash", "")
            self.pending_withdrawals.pop(N, None)
            self._save_state()

        # The withdrawal block is the pool's new frontier — warm its work.
        if broadcast_hash:
            self._warm_frontier_work(broadcast_hash)

        return {
            "ok": True,
            "nullifier": hex(N),
            "broadcast_result": result,
        }


def create_app(guardian: VelaGuardian) -> Flask:
    app = Flask(__name__)

    @app.route("/")
    def health():
        return jsonify({
            "status": "ok",
            "anchor_account": guardian.anchor_address,
            "unanchored_nullifiers": len(guardian.unanchored_nullifiers),
        })

    @app.route("/pool_address")
    def pool_address_route():
        return jsonify({"address": pool_address(10**30, guardian.seed)})

    @app.route("/fee")
    def fee_route():
        return jsonify({"fee_bps": FEE_BPS, "note": "0% of denomination"})

    @app.route("/nullifier/<nullifier_hex>")
    @require_api_key
    def nullifier_status(nullifier_hex):
        try:
            N = int(nullifier_hex, 16)
        except ValueError:
            return jsonify({"error": "invalid nullifier"}), 400
        return jsonify({"nullifier": hex(N), "spent": N in guardian.spent_nullifiers})

    @app.route("/withdraw", methods=["POST"])
    @require_api_key
    def withdraw():
        data = request.json or {}
        result = guardian.withdraw(data)
        if "error" in result:
            return jsonify(result), 400
        return jsonify(result)

    @app.route("/broadcast_withdrawal", methods=["POST"])
    @require_api_key
    def broadcast_withdrawal():
        data = request.json or {}
        result = guardian.broadcast_withdrawal(data)
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
    threading.Thread(target=guardian.pool_receive_loop, daemon=True).start()
    threading.Thread(target=guardian.nullifier_anchor_loop, daemon=True).start()
    app = create_app(guardian)
    serve(app, host="127.0.0.1", port=8081)
