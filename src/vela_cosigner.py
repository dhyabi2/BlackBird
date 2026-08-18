"""
VELA FROST cosigner (guardian ids 2 and 3).

Holds one FROST key share per denomination and contributes signature shares
— but ONLY after independently re-verifying what it is being asked to sign.
This verification is what makes the second machine a real trust boundary:
a compromised coordinator cannot move pool funds through a cosigner except
via a valid ZK withdrawal or a legitimate pool receive.

Policy, per request type:

  withdraw   The full client withdrawal request must be attached. The
             cosigner re-verifies the Groth16 proof, checks the Merkle root
             against its configured indexer, checks the nullifier against
             its OWN persisted nullifier set (marked spent before the share
             is released), and requires the block to send exactly the
             denomination (minus fee) from the pool account to the proven
             P_w, chaining from the current on-chain frontier with an
             unchanged representative.

  receive    The block must receive a confirmed on-chain send addressed to
             the pool account itself, with the exact pending amount, from
             the current frontier (or open the account).

Anything else is refused. The signing-package message must equal the block
hash the cosigner computes from the raw fields itself.

Environment:
  FROST_DATA_DIR, FROST_ID (2 or 3), COSIGNER_API_KEY,
  INDEXER_URL (for root checks), NANO_RPC_KEY / NANO_RPC_URL (own RPC view),
  COSIGNER_PORT (default 8082)
"""
import functools
import json
import os
import secrets
import threading
import time
from typing import Optional

from flask import Flask, request, jsonify

from . import frost_bridge
from .nano_rpc import NanoRPC
from .poseidon_bridge import split32
from .snarkjs_bridge import verify_proof
from .vela_constants import DENOMINATIONS, FEE_BPS
from .vela_crypto import (
    frost_data_dir,
    frost_group_pubkey,
    nano_address_from_pubkey,
    nano_pubkey_from_address,
    nano_state_block_hash,
)

import requests as _requests

ZERO_32 = "0" * 64
NONCE_TTL_SECONDS = 600


def require_api_key(f):
    @functools.wraps(f)
    def decorated(*args, **kwargs):
        expected = os.environ.get("COSIGNER_API_KEY", "")
        if not expected:
            return jsonify({"error": "COSIGNER_API_KEY not configured"}), 500
        provided = request.headers.get("X-VELA-API-Key", "")
        if not provided or not secrets.compare_digest(expected, provided):
            return jsonify({"error": "unauthorized"}), 401
        return f(*args, **kwargs)
    return decorated


class Cosigner:
    def __init__(self, data_dir: Optional[str] = None):
        self.data_dir = data_dir or frost_data_dir()
        self.my_id = int(os.environ.get("FROST_ID", "2"))
        self.indexer_url = os.environ.get("INDEXER_URL", "").rstrip("/")
        self.rpc = NanoRPC()
        self._lock = threading.Lock()
        # request_id -> (nonces_path, created_at)
        self._nonces = {}
        self._nullifier_path = os.path.join(self.data_dir, "cosigner_nullifiers.json")
        self._nullifiers = self._load_nullifiers()

    # -- key material --------------------------------------------------------

    def key_package(self, denomination: int) -> str:
        path = os.path.join(self.data_dir, str(denomination), "key_package")
        if not os.path.isfile(path):
            raise ValueError(f"no key share for denomination {denomination}")
        return path

    def pool_account(self, denomination: int) -> str:
        pub = frost_group_pubkey(denomination)
        if pub is None:
            raise ValueError(f"no group pubkey for denomination {denomination}")
        return nano_address_from_pubkey(pub)

    # -- nullifier persistence ----------------------------------------------

    def _load_nullifiers(self) -> dict:
        """{nullifier hex: {"P_w": hex, "block_hash": hex}}"""
        try:
            with open(self._nullifier_path) as f:
                data = json.load(f)
            if isinstance(data, list):  # legacy plain-set format
                return {x: {} for x in data}
            return data
        except (OSError, ValueError):
            return {}

    def _save_nullifiers(self):
        os.makedirs(self.data_dir, exist_ok=True)
        tmp = self._nullifier_path + ".tmp"
        with open(tmp, "w") as f:
            json.dump(self._nullifiers, f)
        os.replace(tmp, self._nullifier_path)

    # -- round 1: commit -----------------------------------------------------

    def commit(self, request_id: str, denomination: int) -> str:
        kp = self.key_package(denomination)
        nonces_path = os.path.join(
            self.data_dir, "nonces", f"{request_id}.nonces"
        )
        os.makedirs(os.path.dirname(nonces_path), exist_ok=True)
        commitments = frost_bridge.commit(kp, nonces_path)
        with self._lock:
            self._gc_nonces_locked()
            self._nonces[request_id] = (nonces_path, time.time())
        return commitments

    def _gc_nonces_locked(self):
        now = time.time()
        for rid in list(self._nonces):
            path, created = self._nonces[rid]
            if now - created > NONCE_TTL_SECONDS:
                try:
                    os.unlink(path)
                except OSError:
                    pass
                del self._nonces[rid]

    # -- round 2: verify context, then sign ----------------------------------

    def sign(self, request_id: str, denomination: int, signing_package: str, context: dict) -> str:
        with self._lock:
            entry = self._nonces.pop(request_id, None)
        if entry is None:
            raise ValueError("unknown or expired request_id")
        nonces_path = entry[0]

        try:
            # The message inside the signing package must be exactly the hash
            # of the block described by the context — computed by US, from
            # raw fields, not trusted from the coordinator.
            info = frost_bridge.inspect_signing_package(signing_package)
            msg_hex = info["msg"]
            if str(self.my_id) not in info["signer_ids"]:
                raise ValueError("signing package does not include this cosigner")

            block = context.get("block") or {}
            computed = self._block_hash(denomination, block)
            if computed.hex() != msg_hex.lower():
                raise ValueError("signing package message != computed block hash")

            ctx_type = context.get("type")
            if ctx_type == "withdraw":
                self._verify_withdraw(denomination, block, context, computed)
            elif ctx_type == "receive":
                self._verify_receive(denomination, block)
            else:
                raise ValueError(f"refusing to sign context type {ctx_type!r}")

            kp = self.key_package(denomination)
            return frost_bridge.sign(kp, nonces_path, signing_package)
        finally:
            # Whatever happened, these nonces are dead.
            try:
                os.unlink(nonces_path)
            except OSError:
                pass

    def _block_hash(self, denomination: int, block: dict) -> bytes:
        account_pub = nano_pubkey_from_address(block["account"])
        pool_pub = frost_group_pubkey(denomination)
        if pool_pub is None or account_pub != pool_pub:
            raise ValueError("block account is not the threshold pool account")
        return nano_state_block_hash(
            account_pub,
            bytes.fromhex(block["previous"]),
            nano_pubkey_from_address(block["representative"]),
            int(block["balance"]),
            bytes.fromhex(block["link"]),
        )

    def _account_info(self, account: str) -> dict:
        return self.rpc.call("account_info", {"account": account, "representative": "true"})

    def _verify_withdraw(self, denomination: int, block: dict, context: dict, block_hash: bytes):
        req = context.get("request") or {}
        if denomination not in DENOMINATIONS:
            raise ValueError("unsupported denomination")
        if int(req.get("denomination", -1)) != denomination:
            raise ValueError("request denomination mismatch")

        P_w = bytes.fromhex(req["P_w"])
        N = int(req["nullifier"], 16)
        public_signals = req["publicSignals"]
        if len(public_signals) != 4:
            raise ValueError("bad publicSignals")
        if int(public_signals[1]) != N:
            raise ValueError("nullifier not bound in proof")
        P_w_lo, P_w_hi = split32(P_w)
        if int(public_signals[2]) != P_w_lo or int(public_signals[3]) != P_w_hi:
            raise ValueError("P_w not bound in proof")

        # Root check against our configured indexer.
        if not self.indexer_url:
            raise ValueError("INDEXER_URL not configured")
        epoch = int(req["epoch"])
        resp = _requests.get(f"{self.indexer_url}/root/{epoch}/{denomination}", timeout=10)
        resp.raise_for_status()
        expected_root = int(resp.json()["root"], 16)
        if int(public_signals[0]) != expected_root:
            raise ValueError("proof root does not match indexer")

        # Our own nullifier record: refuse double-signing even if the
        # coordinator's set was wiped. Re-signing the SAME withdrawal (same
        # nullifier, same P_w) is allowed only when the previously signed
        # block never made it on-chain — that happens legitimately when the
        # pool frontier moves under a pending withdrawal and the coordinator
        # must re-sign against the new frontier. Because the destination and
        # amount are pinned, at most one such block can ever land.
        with self._lock:
            prior = self._nullifiers.get(hex(N))
        if prior is not None:
            if prior.get("P_w", "").lower() != P_w.hex():
                raise ValueError("nullifier already co-signed for a different destination")
            prior_hash = prior.get("block_hash", "")
            if prior_hash:
                lookup = self.rpc.call("blocks_info", {
                    "hashes": [prior_hash], "json_block": "true",
                })
                found = (lookup.get("blocks") or {})
                if any(k.lower() == prior_hash.lower() for k in found):
                    raise ValueError("nullifier already spent on-chain")

        if not verify_proof(req["proof"], public_signals):
            raise ValueError("Groth16 proof invalid")

        # Ledger checks: exact amount to the proven P_w from the frontier.
        addr = self.pool_account(denomination)
        info = self._account_info(addr)
        if "error" in info:
            raise ValueError(f"pool account_info failed: {info['error']}")
        if block["previous"].lower() != info["frontier"].lower():
            raise ValueError("block does not chain from current frontier")
        if block["representative"] != info["representative"]:
            raise ValueError("representative change not allowed in withdrawal")
        fee = (denomination * FEE_BPS) // 10_000
        expected_balance = int(info["balance"]) - (denomination - fee)
        if expected_balance < 0 or int(block["balance"]) != expected_balance:
            raise ValueError("withdrawal amount mismatch")
        if block["link"].lower() != P_w.hex():
            raise ValueError("withdrawal destination is not the proven P_w")

        # Record BEFORE releasing the share: if we crash after signing, we
        # must never contribute a share for this nullifier to a different
        # destination.
        with self._lock:
            self._nullifiers[hex(N)] = {"P_w": P_w.hex(), "block_hash": block_hash.hex()}
            self._save_nullifiers()

    def _verify_receive(self, denomination: int, block: dict):
        addr = self.pool_account(denomination)
        info = self._account_info(addr)
        if info.get("error") == "Account not found":
            prev_balance = 0
            if block["previous"].lower() != ZERO_32:
                raise ValueError("open block must have zero previous")
        elif "error" in info:
            raise ValueError(f"pool account_info failed: {info['error']}")
        else:
            prev_balance = int(info["balance"])
            if block["previous"].lower() != info["frontier"].lower():
                raise ValueError("block does not chain from current frontier")

        amount = int(block["balance"]) - prev_balance
        if amount <= 0:
            raise ValueError("receive must increase balance")

        # The link must be a confirmed send addressed to the pool account
        # with exactly this amount — checked through our own RPC view.
        send_hash = block["link"]
        blocks = self.rpc.call("blocks_info", {
            "hashes": [send_hash], "json_block": "true", "pending": "true",
        })
        send = (blocks.get("blocks") or {}).get(send_hash.upper()) or \
               (blocks.get("blocks") or {}).get(send_hash.lower()) or \
               (blocks.get("blocks") or {}).get(send_hash)
        if not send:
            raise ValueError("source send block not found")
        if send.get("confirmed") != "true":
            raise ValueError("source send not confirmed")
        contents = send.get("contents", send)
        dest_pub = contents.get("link", "").lower()
        pool_pub = frost_group_pubkey(denomination).hex()
        if dest_pub != pool_pub:
            raise ValueError("source send is not addressed to the pool account")
        if int(send.get("amount", 0)) != amount:
            raise ValueError("receive amount mismatch")


def create_app(cosigner: Cosigner) -> Flask:
    app = Flask(__name__)

    @app.route("/")
    def health():
        denoms = []
        for d in sorted(DENOMINATIONS):
            if frost_group_pubkey(d) is not None:
                try:
                    cosigner.key_package(d)
                    denoms.append(str(d))
                except ValueError:
                    pass
        return jsonify({"status": "ok", "frost_id": cosigner.my_id, "denominations": denoms})

    @app.route("/frost/commit", methods=["POST"])
    @require_api_key
    def frost_commit():
        data = request.json or {}
        try:
            request_id = str(data["request_id"])
            denomination = int(data["denomination"])
            commitments = cosigner.commit(request_id, denomination)
            return jsonify({"commitments": commitments})
        except Exception as e:
            return jsonify({"error": str(e)}), 400

    @app.route("/frost/sign", methods=["POST"])
    @require_api_key
    def frost_sign():
        data = request.json or {}
        try:
            share = cosigner.sign(
                str(data["request_id"]),
                int(data["denomination"]),
                str(data["signing_package"]),
                data.get("context") or {},
            )
            return jsonify({"signature_share": share})
        except Exception as e:
            print("cosign refused:", e)
            return jsonify({"error": str(e)}), 400

    return app


if __name__ == "__main__":
    from waitress import serve
    cosigner = Cosigner()
    app = create_app(cosigner)
    port = int(os.environ.get("COSIGNER_PORT", "8082"))
    serve(app, host="127.0.0.1", port=port)
