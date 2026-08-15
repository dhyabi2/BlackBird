"""
VELA v2 Client CLI.

Prepares deposits and generates Groth16 ZK proofs for withdrawals.
"""
import argparse
import hashlib
import json
import os
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
    compute_commitment,
    compute_nullifier,
    pool_pubkey,
)
from .poseidon_bridge import split32, field_to_bytes32
from .snarkjs_bridge import generate_proof
from .nano_rpc import NanoRPC

POW_THRESHOLD = 0xFFFFFFF800000000


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
    a, A, b, B = derive_view_spend(seed_view)
    velaid = {
        "seed_view": seed_view.hex(),
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
    t = os.urandom(32)
    C = compute_commitment(n, t, P_w, source_pub)
    C_bytes = field_to_bytes32(C)
    # commitment int is field element; bytes32 representation used as block link

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
    commit_hash = nano_state_block_hash(source_pub, deposit_hash, rep_pub, commit_balance, C_bytes)
    commit_sig = sign_message(source_sk, commit_hash)
    commit_work = compute_pow(commit_hash) if not args.no_pow else "0000000000000000"
    commit_block = {
        "type": "state",
        "account": source_address,
        "previous": deposit_hash.hex(),
        "representative": rep_address,
        "balance": str(commit_balance),
        "link": C_bytes.hex(),
        "signature": commit_sig.hex(),
        "work": commit_work,
    }

    print(json.dumps({
        "source_address": source_address,
        "withdraw_address": withdraw_address,
        "commitment": hex(C),
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

    indexer_url = args.indexer_url
    root_resp = requests.get(f"{indexer_url}/root/{epoch}/{denom}", timeout=10)
    root_resp.raise_for_status()
    root = int(root_resp.json()["root"], 16)

    proof_resp = requests.get(f"{indexer_url}/proof/{epoch}/{denom}?C={hex(C)}", timeout=10)
    proof_resp.raise_for_status()
    merkle_proof = proof_resp.json()

    n_lo, n_hi = split32(n)
    t_lo, t_hi = split32(t)
    P_w_lo, P_w_hi = split32(P_w)
    S_pub_lo, S_pub_hi = split32(S_pub)

    input_signals = {
        "root": str(root),
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

    print("Generating Groth16 proof...", file=sys.stderr)
    zk = generate_proof(input_signals)
    proof = zk["proof"]
    public_signals = zk["publicSignals"]

    req = {
        "epoch": epoch,
        "denomination": denom,
        "P_w": P_w.hex(),
        "nullifier": hex(N),
        "proof": proof,
        "publicSignals": public_signals,
    }

    guardian_url = args.guardian_url
    resp = requests.post(f"{guardian_url}/withdraw", json=req, timeout=60)
    result = resp.json()
    if "error" in result:
        print(json.dumps(result, indent=2))
        return

    block = result["block"]
    if args.broadcast and not args.no_pow:
        block_hash = bytes.fromhex(result.get("block_hash", ""))
        if not block_hash:
            account = nano_pubkey_from_address(block["account"])
            previous = bytes.fromhex(block["previous"])
            rep = nano_pubkey_from_address(block["representative"])
            balance = int(block["balance"])
            link = bytes.fromhex(block["link"])
            block_hash = nano_state_block_hash(account, previous, rep, balance, link)
        block["work"] = compute_pow(block_hash)
        rpc = NanoRPC()
        broadcast_result = rpc.call("process", {"json_block": "true", "block": block})
        result["broadcast"] = broadcast_result
    print(json.dumps(result, indent=2))


def main():
    parser = argparse.ArgumentParser(description="VELA v2 client")
    sub = parser.add_subparsers(dest="command")

    sub.add_parser("generate", help="Generate a new VelaID")

    dep = sub.add_parser("deposit", help="Prepare a deposit")
    dep.add_argument("source_seed")
    dep.add_argument("view_seed")
    dep.add_argument("denomination")
    dep.add_argument("--no-pow", action="store_true", help="Skip PoW computation")

    wit = sub.add_parser("withdraw", help="Request a withdrawal using a Groth16 ZK proof")
    wit.add_argument("nullifier_secret")
    wit.add_argument("trapdoor")
    wit.add_argument("P_w")
    wit.add_argument("S_pub")
    wit.add_argument("denomination")
    wit.add_argument("epoch", type=int)
    wit.add_argument("--indexer-url", default="http://127.0.0.1:8080")
    wit.add_argument("--guardian-url", default="http://127.0.0.1:8081")
    wit.add_argument("--broadcast", action="store_true", help="Compute PoW and broadcast withdrawal block")
    wit.add_argument("--no-pow", action="store_true", help="Skip PoW computation")

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
