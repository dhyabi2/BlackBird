"""
VELA v2 Client CLI (prototype).
"""

import argparse
import hashlib
import json
import os
import struct
import sys
import time
from typing import List, Optional

import requests

from .vela_crypto import (
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
)

NANO_RPC_ENDPOINTS = [
    "https://app.nanolooker.com/api/rpc",
    "https://proxy.nanos.cc/proxy",
]

# Default Nano PoW threshold for mainnet send/receive
POW_THRESHOLD = 0xFFFFFFF800000000


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


def compute_pow(block_hash: bytes, threshold: int = POW_THRESHOLD) -> str:
    """Compute Nano PoW locally (CPU)."""
    nonce = 0
    while True:
        nonce_bytes = nonce.to_bytes(8, "big")
        h = int.from_bytes(hashlib.blake2b(nonce_bytes + block_hash, digest_size=8).digest(), "big")
        if h >= threshold:
            return nonce_bytes.hex().upper()
        nonce += 1
        if nonce % 1000000 == 0:
            print(f"  PoW iterations: {nonce}", file=sys.stderr)


def cmd_generate(args):
    seed_view = os.urandom(32)
    seed_spend = os.urandom(32)
    a, A, b, B = derive_view_spend(seed_view)
    velaid = {
        "seed_view": seed_view.hex(),
        "seed_spend": seed_spend.hex(),
        "A": A.hex(),
        "B": B.hex(),
    }
    print(json.dumps(velaid, indent=2))


def cmd_deposit(args):
    rpc = NanoRPC()
    seed_source = bytes.fromhex(args.source_seed)
    denom = int(float(args.denomination) * 1e30)

    source_sk, source_pub = nano_seed_to_keypair(seed_source)
    source_address = nano_address_from_pubkey(source_pub)

    view_seed = bytes.fromhex(args.view_seed)
    a, A, b, B = derive_view_spend(view_seed)
    R, P_w, H_s = stealth_address(A, B)
    withdraw_address = nano_address_from_pubkey(P_w)

    n = os.urandom(32)
    t, C = find_valid_commitment(n, P_w, source_pub)
    commit_address = nano_address_from_pubkey(C)

    info = rpc.call("account_info", {"account": source_address, "representative": "true"})
    if "error" in info:
        print(f"Source account error: {info['error']}")
        return

    balance = int(info["balance"])
    if balance < denom + 1:
        print(f"Insufficient balance: {balance} < {denom + 1}")
        return

    previous = bytes.fromhex(info["frontier"])
    rep_address = info.get("representative", source_address)
    rep_pub = nano_pubkey_from_address(rep_address)

    # Deposit block
    deposit_balance = balance - denom
    deposit_hash = nano_state_block_hash(source_pub, previous, rep_pub, deposit_balance, pool_pubkey(denom))
    deposit_sig = sign_message(source_sk, deposit_hash)
    deposit_work = compute_pow(deposit_hash) if not args.no_pow else "0000000000000000"
    deposit_block = {
        "type": "state",
        "account": source_address,
        "previous": previous.hex(),
        "representative": rep_address,
        "balance": str(deposit_balance),
        "link": pool_pubkey(denom).hex(),
        "signature": deposit_sig.hex(),
        "work": deposit_work,
    }

    # Commitment block (previous = deposit_hash)
    commit_balance = deposit_balance - 1
    commit_hash = nano_state_block_hash(source_pub, deposit_hash, rep_pub, commit_balance, C)
    commit_sig = sign_message(source_sk, commit_hash)
    commit_work = compute_pow(commit_hash) if not args.no_pow else "0000000000000000"
    commit_block = {
        "type": "state",
        "account": source_address,
        "previous": deposit_hash.hex(),
        "representative": rep_address,
        "balance": str(commit_balance),
        "link": C.hex(),
        "signature": commit_sig.hex(),
        "work": commit_work,
    }

    print(json.dumps({
        "source_address": source_address,
        "withdraw_address": withdraw_address,
        "commitment_address": commit_address,
        "commitment": C.hex(),
        "nullifier_secret": n.hex(),
        "trapdoor": t.hex(),
        "P_w": P_w.hex(),
        "S_pub": source_pub.hex(),
        "epoch": int(time.time()) // 86400,
        "denomination": denom,
        "deposit_hash": deposit_hash.hex(),
        "commit_hash": commit_hash.hex(),
        "deposit_block": deposit_block,
        "commit_block": commit_block,
    }, indent=2))


def cmd_withdraw(args):
    n = bytes.fromhex(args.nullifier_secret)
    t = bytes.fromhex(args.trapdoor)
    P_w = bytes.fromhex(args.P_w)
    S_pub = bytes.fromhex(args.S_pub)
    C = compute_commitment(n, t, P_w, S_pub)
    N = compute_nullifier(n)
    denom = int(float(args.denomination) * 1e30)
    epoch = args.epoch
    deposit_hash = args.deposit_hash

    source_seed = bytes.fromhex(args.source_seed)
    source_sk, _ = nano_seed_to_keypair(source_seed)
    challenge = hashlib.blake2b(N + P_w, digest_size=32).digest()
    client_sig = sign_message(source_sk, challenge)

    indexer_url = args.indexer_url
    proof_resp = requests.get(f"{indexer_url}/proof/{epoch}/{denom}?C={C.hex()}", timeout=10)
    proof_resp.raise_for_status()
    proof = proof_resp.json()

    req = {
        "n": n.hex(),
        "t": t.hex(),
        "P_w": P_w.hex(),
        "S_pub": S_pub.hex(),
        "C": C.hex(),
        "epoch": epoch,
        "denomination": denom,
        "deposit_hash": deposit_hash,
        "client_sig": client_sig.hex(),
        "proof": proof,
    }

    guardian_url = args.guardian_url
    resp = requests.post(f"{guardian_url}/withdraw", json=req, timeout=30)
    print(resp.text)


def main():
    parser = argparse.ArgumentParser(description="VELA v2 prototype client")
    sub = parser.add_subparsers(dest="command")

    sub.add_parser("generate", help="Generate a new VelaID")

    dep = sub.add_parser("deposit", help="Prepare a deposit")
    dep.add_argument("source_seed")
    dep.add_argument("view_seed")
    dep.add_argument("denomination")
    dep.add_argument("--no-pow", action="store_true", help="Skip PoW computation")

    wit = sub.add_parser("withdraw", help="Request a withdrawal")
    wit.add_argument("source_seed")
    wit.add_argument("nullifier_secret")
    wit.add_argument("trapdoor")
    wit.add_argument("P_w")
    wit.add_argument("S_pub")
    wit.add_argument("deposit_hash")
    wit.add_argument("denomination")
    wit.add_argument("epoch", type=int)
    wit.add_argument("--indexer-url", default="http://127.0.0.1:8080")
    wit.add_argument("--guardian-url", default="http://127.0.0.1:8081")

    args = parser.parse_args()
    if args.command == "generate":
        cmd_generate(args)
    elif args.command == "deposit":
        cmd_deposit(args)
    elif args.command == "withdraw":
        cmd_withdraw(args)
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
