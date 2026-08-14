"""
End-to-end test of VELA v2 core prototype with mocked Nano RPC.
"""
import hashlib
import os
import sys
import time
import threading

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src.vela_crypto import (
    nano_seed_to_keypair,
    nano_address_from_pubkey,
    nano_pubkey_from_address,
    nano_state_block_hash,
    sign_message,
    derive_view_spend,
    stealth_address,
    find_valid_commitment,
    compute_commitment,
    compute_nullifier,
    pool_pubkey,
    pool_address,
)
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
    t, C = find_valid_commitment(n, P_w, source_pub)

    rep = source_address
    rep_pub = source_pub

    # Source starts with denom + 1 raw
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
    commit_hash = nano_state_block_hash(source_pub, deposit_hash, rep_pub, commit_balance, C)
    commit_sig = sign_message(source_sk, commit_hash)
    commit_block = {
        "type": "state",
        "account": source_address,
        "previous": deposit_hash.hex(),
        "representative": rep,
        "balance": str(commit_balance),
        "link": C.hex(),
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
        "deposit_hash": deposit_hash.hex(),
        "commit_hash": commit_hash.hex(),
        "deposit_block": deposit_block,
        "commit_block": commit_block,
        "epoch": int(time.time()) // 86400,
        "denomination": denom,
    }


def test_e2e():
    denom = 10**30  # 1 XNO

    source_seed = os.urandom(32)
    view_seed = os.urandom(32)
    guardian_seed = os.urandom(32)

    info = build_fake_deposit_commitment(source_seed, view_seed, denom)

    # Set up fake RPC
    fake_rpc = FakeRPC()
    fake_rpc.add_account(info["source_address"], denom + 1)
    fake_rpc.set_block(info["deposit_hash"], {
        "block_account": info["source_address"],
        "amount": str(denom),
        "local_timestamp": str(int(time.time())),
        "contents": info["deposit_block"],
    })
    fake_rpc.set_block(info["commit_hash"], {
        "block_account": info["source_address"],
        "local_timestamp": str(int(time.time())),
        "contents": info["commit_block"],
    })

    # Guardian pool account needs balance
    guardian = VelaGuardian(guardian_seed)
    fake_rpc.add_account(guardian.pool_address, denom * 10)

    # Patch RPC instances
    indexer = VelaIndexer(data_dir="data/test_indexer")
    indexer.rpc = fake_rpc

    guardian.rpc = fake_rpc

    # Build Flask test apps
    indexer_app = create_app(indexer)
    guardian_app = create_guardian_app(guardian)

    indexer_client = indexer_app.test_client()
    guardian_client = guardian_app.test_client()

    # Patch guardian to talk to indexer test client
    def indexer_get(path):
        resp = indexer_client.get(path)
        return resp.json

    def indexer_post(path, data):
        resp = indexer_client.post(path, json=data)
        return resp.json

    guardian._indexer_get = indexer_get
    guardian._indexer_post = indexer_post

    # Submit deposit/commitment pair
    resp = indexer_client.post("/submit", json={
        "deposit_hash": info["deposit_hash"],
        "commit_hash": info["commit_hash"],
    })
    assert resp.status_code == 200, resp.json
    print("Indexer submit:", resp.json)

    # Check root
    resp = indexer_client.get(f"/root/{info['epoch']}/{denom}")
    assert resp.status_code == 200, resp.json
    root = resp.json["root"]
    print("Root:", root)

    # Check proof
    resp = indexer_client.get(f"/proof/{info['epoch']}/{denom}?C={info['C'].hex()}")
    assert resp.status_code == 200, resp.json
    proof = resp.json
    print("Proof indices:", proof["indices"])

    # Build withdrawal request
    N = compute_nullifier(info["n"])
    challenge = hashlib.blake2b(N + info["P_w"], digest_size=32).digest()
    client_sig = sign_message(info["source_sk"], challenge)

    req = {
        "n": info["n"].hex(),
        "t": info["t"].hex(),
        "P_w": info["P_w"].hex(),
        "S_pub": info["source_pub"].hex(),
        "C": info["C"].hex(),
        "epoch": info["epoch"],
        "denomination": denom,
        "deposit_hash": info["deposit_hash"],
        "client_sig": client_sig.hex(),
        "proof": proof,
    }

    resp = guardian_client.post("/withdraw", json=req)
    print("Withdraw status:", resp.status_code)
    print("Withdraw response:", resp.json)
    assert resp.status_code == 200, resp.json
    block = resp.json["block"]
    assert block["account"] == guardian.pool_address
    assert block["link"] == info["P_w"].hex()

    # Verify nullifier marked spent
    assert compute_nullifier(info["n"]) in guardian.spent_nullifiers
    print("E2E test passed!")


if __name__ == "__main__":
    test_e2e()
