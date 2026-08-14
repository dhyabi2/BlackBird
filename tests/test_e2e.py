"""
End-to-end test of VELA v2 with mocked Nano RPC and real Groth16 proofs.
"""
import hashlib
import os
import shutil
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src.vela_crypto import (
    nano_seed_to_keypair,
    nano_address_from_pubkey,
    nano_state_block_hash,
    sign_message,
    derive_view_spend,
    stealth_address,
    compute_commitment,
    compute_nullifier,
    pool_pubkey,
)
from src.poseidon_bridge import split32, field_to_bytes32
from src.snarkjs_bridge import generate_proof
from src.vela_indexer import VelaIndexer, create_app
from src.vela_guardian import VelaGuardian, create_app as create_guardian_app


class FakeRPC:
    """In-memory Nano RPC for testing."""

    def __init__(self):
        self.blocks = {}
        self.balances = {}
        self.frontiers = {}
        self.reps = {}

    def add_account(self, address, balance, frontier=None, rep=None):
        self.balances[address] = balance
        self.frontiers[address] = frontier or bytes(32).hex()
        self.reps[address] = rep or address

    def set_block(self, block_hash, block_info):
        self.blocks[block_hash] = block_info

    def call(self, action, params):
        if action == "account_info":
            account = params["account"]
            return {
                "balance": str(self.balances.get(account, 0)),
                "frontier": self.frontiers.get(account, bytes(32).hex()),
                "representative": self.reps.get(account, account),
            }
        if action == "block_info":
            h = params["hash"]
            return self.blocks.get(h, {"error": "block not found"})
        if action == "blocks_info":
            import json
            hashes = json.loads(params["hashes"])
            return {"blocks": {h: self.blocks.get(h, {"error": "block not found"}) for h in hashes}}
        if action == "process":
            block = params["block"]
            h = hashlib.blake2b(block["signature"].encode(), digest_size=32).hexdigest()
            self.blocks[h] = block
            return {"hash": h}
        return {"error": "unknown action"}


def build_fake_deposit_commitment(source_seed, view_seed, denom):
    source_sk, source_pub = nano_seed_to_keypair(source_seed)
    source_address = nano_address_from_pubkey(source_pub)
    a, A, b, B = derive_view_spend(view_seed)
    R, P_w, _ = stealth_address(A, B)
    withdraw_address = nano_address_from_pubkey(P_w)
    n = os.urandom(32)
    t = os.urandom(32)
    C = compute_commitment(n, t, P_w, source_pub)
    C_bytes = field_to_bytes32(C)

    rep = source_address
    rep_pub = source_pub

    balance = denom + 1
    previous = bytes(32)

    deposit_balance = balance - denom
    deposit_hash = nano_state_block_hash(source_pub, previous, rep_pub, deposit_balance, pool_pubkey(denom))
    deposit_sig = sign_message(source_sk, deposit_hash)
    deposit_block = {
        "type": "state",
        "account": source_address,
        "previous": previous.hex(),
        "representative": rep,
        "balance": str(deposit_balance),
        "link": pool_pubkey(denom).hex(),
        "signature": deposit_sig.hex(),
    }

    commit_balance = deposit_balance - 1
    commit_hash = nano_state_block_hash(source_pub, deposit_hash, rep_pub, commit_balance, C_bytes)
    commit_sig = sign_message(source_sk, commit_hash)
    commit_block = {
        "type": "state",
        "account": source_address,
        "previous": deposit_hash.hex(),
        "representative": rep,
        "balance": str(commit_balance),
        "link": C_bytes.hex(),
        "signature": commit_sig.hex(),
    }

    return {
        "source_address": source_address,
        "source_pub": source_pub,
        "source_sk": source_sk,
        "P_w": P_w,
        "withdraw_address": withdraw_address,
        "n": n,
        "t": t,
        "C": C,
        "C_bytes": C_bytes,
        "deposit_hash": deposit_hash.hex(),
        "commit_hash": commit_hash.hex(),
        "deposit_block": deposit_block,
        "commit_block": commit_block,
        "epoch": int(time.time()) // 86400,
        "denomination": denom,
    }


def test_e2e():
    denom = 10**30

    source_seed = os.urandom(32)
    view_seed = os.urandom(32)
    guardian_seed = os.urandom(32)

    info = build_fake_deposit_commitment(source_seed, view_seed, denom)

    fake_rpc = FakeRPC()
    fake_rpc.add_account(info["source_address"], denom + 1)
    fake_rpc.set_block(info["deposit_hash"], {
        "amount": str(denom),
        "local_timestamp": str(int(time.time())),
        "contents": info["deposit_block"],
    })
    fake_rpc.set_block(info["commit_hash"], {
        "local_timestamp": str(int(time.time())),
        "contents": info["commit_block"],
    })

    guardian_data_dir = "data/test_guardian"
    if os.path.exists(guardian_data_dir):
        shutil.rmtree(guardian_data_dir)
    guardian = VelaGuardian(guardian_seed, data_dir=guardian_data_dir)
    fake_rpc.add_account(guardian.pool_address, denom * 10)

    data_dir = "data/test_indexer"
    if os.path.exists(data_dir):
        shutil.rmtree(data_dir)
    indexer = VelaIndexer(data_dir=data_dir)
    indexer.rpc = fake_rpc
    guardian.rpc = fake_rpc

    indexer_app = create_app(indexer)
    guardian_app = create_guardian_app(guardian)

    indexer_client = indexer_app.test_client()
    guardian_client = guardian_app.test_client()

    def indexer_get(path):
        resp = indexer_client.get(path)
        return resp.json

    guardian._indexer_get = indexer_get

    resp = indexer_client.post("/submit", json={
        "deposit_hash": info["deposit_hash"],
        "commit_hash": info["commit_hash"],
    })
    assert resp.status_code == 200, resp.json
    print("Indexer submit:", resp.json)

    resp = indexer_client.get(f"/root/{info['epoch']}/{denom}")
    assert resp.status_code == 200, resp.json
    root = int(resp.json["root"], 16)
    print("Root:", hex(root))

    resp = indexer_client.get(f"/proof/{info['epoch']}/{denom}?C={hex(info['C'])}")
    assert resp.status_code == 200, resp.json
    merkle_proof = resp.json
    print("Proof indices:", merkle_proof["indices"])

    N = compute_nullifier(info["n"])
    n_lo, n_hi = split32(info["n"])
    t_lo, t_hi = split32(info["t"])
    P_w_lo, P_w_hi = split32(info["P_w"])
    S_pub_lo, S_pub_hi = split32(info["source_pub"])

    input_signals = {
        "root": root,
        "nullifier": str(N),
        "P_w_lo": str(P_w_lo),
        "P_w_hi": str(P_w_hi),
        "n_lo": str(n_lo),
        "n_hi": str(n_hi),
        "t_lo": str(t_lo),
        "t_hi": str(t_hi),
        "S_pub_lo": str(S_pub_lo),
        "S_pub_hi": str(S_pub_hi),
        "leafIndex": merkle_proof["indices"],
        "path": merkle_proof["path"],
    }

    print("Generating Groth16 proof...")
    zk = generate_proof(input_signals)
    print("Proof generated")

    req = {
        "epoch": info["epoch"],
        "denomination": denom,
        "P_w": info["P_w"].hex(),
        "nullifier": hex(N),
        "proof": zk["proof"],
        "publicSignals": zk["publicSignals"],
    }

    resp = guardian_client.post("/withdraw", json=req)
    print("Withdraw status:", resp.status_code)
    print("Withdraw response:", resp.json)
    assert resp.status_code == 200, resp.json
    block = resp.json["block"]
    assert block["account"] == guardian.pool_address
    assert block["link"] == info["P_w"].hex()

    assert N in guardian.spent_nullifiers
    print("E2E test passed!")


if __name__ == "__main__":
    test_e2e()
