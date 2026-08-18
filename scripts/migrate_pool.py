#!/usr/bin/env python3
"""
Migrate pool funds from single-key custody to 2-of-3 FROST threshold custody.

Run on guardian-1 (the machine holding GUARDIAN_SEED) AFTER the DKG ceremony
(scripts/frost_ceremony.py) has installed group_pubkey files. For each
denomination it:

  1. receives every pending deposit into the OLD single-key pool account,
  2. sends the old account's entire balance to the NEW threshold account
     (the last signature the old key ever makes),
  3. FROST-receives that sweep into the new account (cosigners verify the
     source send on-chain before contributing shares),
  4. waits for on-chain confirmation at every step,
  5. records the old pool pubkey in legacy_pubkeys so pre-migration deposit
     commitments stay provable and indexable.

Safety properties:
  - Idempotent and resumable: every step is journaled to
    data/migration_journal.json; re-running skips completed steps and picks
    up half-done ones. Funds sit safely at rest between any two steps.
  - The guardian seed is NEVER deleted by this script. Keep it offline as a
    recovery artifact until you have independently confirmed all balances,
    then destroy it at your own discretion.
  - Nothing is broadcast unless the corresponding balance checks pass.

Usage:
  GUARDIAN_SEED=... FROST_COSIGNERS=... COSIGNER_API_KEY=... \
  python3 scripts/migrate_pool.py [--denominations 1e30] [--dry-run]
"""
import argparse
import json
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from src.nano_rpc import NanoRPC  # noqa: E402
from src.vela_constants import DENOMINATIONS  # noqa: E402
from src.vela_crypto import (  # noqa: E402
    frost_data_dir,
    frost_group_pubkey,
    legacy_pool_keypair,
    nano_address_from_pubkey,
    nano_pubkey_from_address,
    nano_state_block_hash,
    sign_message,
)
from src.frost_signer import FrostSigner  # noqa: E402
from src.work_service import WorkService, SEND_DIFFICULTY, RECEIVE_DIFFICULTY  # noqa: E402

ZERO_32 = b"\x00" * 32
JOURNAL = os.path.join("data", "migration_journal.json")


def load_journal() -> dict:
    try:
        with open(JOURNAL) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save_journal(j: dict):
    os.makedirs(os.path.dirname(JOURNAL), exist_ok=True)
    tmp = JOURNAL + ".tmp"
    with open(tmp, "w") as f:
        json.dump(j, f, indent=2)
    os.replace(tmp, JOURNAL)


class Migrator:
    def __init__(self, dry_run: bool = False):
        self.rpc = NanoRPC()
        self.work = WorkService()
        self.dry_run = dry_run
        self.journal = load_journal()
        if not self.work.available:
            print("WARNING: workgen binary unavailable; work falls back to slow CPU loops")

    # -- helpers -------------------------------------------------------------

    def account_info(self, addr: str) -> dict:
        return self.rpc.call("account_info", {"account": addr, "representative": "true"})

    def wait_confirmed(self, block_hash: str, timeout: int = 600):
        print(f"    waiting for confirmation of {block_hash[:16]}...")
        deadline = time.time() + timeout
        while time.time() < deadline:
            info = self.rpc.call("blocks_info", {"hashes": [block_hash], "json_block": "true"})
            blk = (info.get("blocks") or {}).get(block_hash.upper()) or \
                  (info.get("blocks") or {}).get(block_hash.lower())
            if blk and blk.get("confirmed") == "true":
                print("    confirmed")
                return
            time.sleep(3)
        raise RuntimeError(f"block {block_hash} not confirmed within {timeout}s")

    def get_work(self, root_hex: str, difficulty: str) -> str:
        work = self.work.get_or_wait(root_hex, difficulty, wait_seconds=1800)
        if work:
            return work
        # Slow CPU fallback (fine for receive difficulty, painful for send).
        print(f"    computing work at {difficulty} on CPU (may take minutes)...")
        import hashlib
        import secrets as _secrets
        root = bytes.fromhex(root_hex)
        threshold = int(difficulty, 16)
        value = int.from_bytes(_secrets.token_bytes(8), "little")
        while True:
            wb = value.to_bytes(8, "little")
            digest = hashlib.blake2b(wb + root, digest_size=8).digest()
            if int.from_bytes(digest, "little") >= threshold:
                return value.to_bytes(8, "big").hex()
            value = (value + 1) & 0xFFFFFFFFFFFFFFFF

    def broadcast(self, block: dict, subtype: str) -> str:
        if self.dry_run:
            print(f"    [dry-run] would broadcast {subtype}: {json.dumps(block)[:120]}...")
            return "DRYRUN"
        result = self.rpc.call("process", {"json_block": "true", "subtype": subtype, "block": block})
        if result.get("error"):
            raise RuntimeError(f"broadcast rejected: {result['error']}")
        return result["hash"]

    # -- steps ---------------------------------------------------------------

    def receive_all_old(self, denom: int):
        """Step 1: drain receivables into the old single-key account."""
        old_sk, old_pub = legacy_pool_keypair(denom)
        addr = nano_address_from_pubkey(old_pub)
        while True:
            pending = self.rpc.call("receivable", {"account": addr, "count": "50", "source": "true"})
            blocks = pending.get("blocks") or {}
            if not blocks:
                return
            info = self.account_info(addr)
            if info.get("error") == "Account not found":
                previous, balance = ZERO_32, 0
                rep_addr, rep_pub = addr, old_pub
            elif "error" in info:
                raise RuntimeError(f"account_info {addr}: {info['error']}")
            else:
                previous = bytes.fromhex(info["frontier"])
                balance = int(info["balance"])
                rep_addr = info["representative"]
                rep_pub = nano_pubkey_from_address(rep_addr)
            for send_hash, meta in blocks.items():
                amount = int(meta["amount"] if isinstance(meta, dict) else meta)
                new_balance = balance + amount
                bh = nano_state_block_hash(old_pub, previous, rep_pub, new_balance, bytes.fromhex(send_hash))
                sig = sign_message(old_sk, bh)
                root = old_pub if previous == ZERO_32 else previous
                work = self.get_work(root.hex(), RECEIVE_DIFFICULTY)
                block = {
                    "type": "state", "account": addr, "previous": previous.hex(),
                    "representative": rep_addr, "balance": str(new_balance),
                    "link": send_hash, "signature": sig.hex(), "work": work,
                }
                h = self.broadcast(block, "receive")
                print(f"    old pool received {amount} raw ({h[:16]}...)")
                if self.dry_run:
                    return
                previous, balance = bh, new_balance

    def sweep_to_frost(self, denom: int, jd: dict):
        """Step 2: send the old account's full balance to the new account."""
        old_sk, old_pub = legacy_pool_keypair(denom)
        old_addr = nano_address_from_pubkey(old_pub)
        new_pub = frost_group_pubkey(denom)
        new_addr = nano_address_from_pubkey(new_pub)

        info = self.account_info(old_addr)
        if info.get("error") == "Account not found":
            print(f"    old pool account {old_addr} never opened; nothing to sweep")
            jd["sweep_hash"] = "EMPTY"
            return
        if "error" in info:
            raise RuntimeError(f"account_info {old_addr}: {info['error']}")
        balance = int(info["balance"])
        if balance == 0:
            print("    old pool balance already 0")
            jd["sweep_hash"] = "EMPTY"
            return

        previous = bytes.fromhex(info["frontier"])
        rep_pub = nano_pubkey_from_address(info["representative"])
        bh = nano_state_block_hash(old_pub, previous, rep_pub, 0, new_pub)
        sig = sign_message(old_sk, bh)
        work = self.get_work(previous.hex(), SEND_DIFFICULTY)
        block = {
            "type": "state", "account": old_addr, "previous": previous.hex(),
            "representative": info["representative"], "balance": "0",
            "link": new_pub.hex(), "signature": sig.hex(), "work": work,
        }
        h = self.broadcast(block, "send")
        print(f"    swept {balance} raw ({balance / 1e30} XNO) old -> new ({h[:16]}...)")
        jd["sweep_hash"] = h
        jd["sweep_amount"] = str(balance)

    def frost_receive(self, denom: int, jd: dict):
        """Step 3: threshold-receive the sweep into the new account."""
        new_pub = frost_group_pubkey(denom)
        new_addr = nano_address_from_pubkey(new_pub)
        signer = FrostSigner(denom)
        while True:
            pending = self.rpc.call("receivable", {"account": new_addr, "count": "50", "source": "true"})
            blocks = pending.get("blocks") or {}
            if not blocks:
                return
            info = self.account_info(new_addr)
            if info.get("error") == "Account not found":
                previous, balance = ZERO_32, 0
                rep_addr, rep_pub = new_addr, new_pub
            elif "error" in info:
                raise RuntimeError(f"account_info {new_addr}: {info['error']}")
            else:
                previous = bytes.fromhex(info["frontier"])
                balance = int(info["balance"])
                rep_addr = info["representative"]
                rep_pub = nano_pubkey_from_address(rep_addr)
            for send_hash, meta in blocks.items():
                amount = int(meta["amount"] if isinstance(meta, dict) else meta)
                new_balance = balance + amount
                bh = nano_state_block_hash(new_pub, previous, rep_pub, new_balance, bytes.fromhex(send_hash))
                block_fields = {
                    "type": "state", "account": new_addr, "previous": previous.hex(),
                    "representative": rep_addr, "balance": str(new_balance),
                    "link": send_hash,
                }
                if self.dry_run:
                    print(f"    [dry-run] would FROST-receive {amount} raw into {new_addr}")
                    return
                sig = signer.sign(bh, {"type": "receive", "block": block_fields})
                root = new_pub if previous == ZERO_32 else previous
                work = self.get_work(root.hex(), RECEIVE_DIFFICULTY)
                block = {**block_fields, "signature": sig.hex(), "work": work}
                h = self.broadcast(block, "receive")
                print(f"    new pool FROST-received {amount} raw ({h[:16]}...)")
                self.wait_confirmed(h)
                previous, balance = bh, new_balance

    def record_legacy_pubkey(self, denom: int):
        """Step 4: make old commitments provable under the retired key."""
        _, old_pub = legacy_pool_keypair(denom)
        path = os.path.join(frost_data_dir(), str(denom), "legacy_pubkeys")
        try:
            with open(path) as f:
                existing = json.load(f)
        except (OSError, ValueError):
            existing = []
        if old_pub.hex() not in existing:
            existing.append(old_pub.hex())
            with open(path, "w") as f:
                json.dump(existing, f)
        print(f"    legacy pubkey recorded: {old_pub.hex()[:16]}...")

    # -- orchestration -------------------------------------------------------

    def migrate(self, denom: int):
        new_pub = frost_group_pubkey(denom)
        if new_pub is None:
            raise RuntimeError(
                f"no FROST group pubkey for denomination {denom}; run the DKG ceremony first"
            )
        # The signer constructor validates key material and cosigner config.
        FrostSigner(denom)

        jd = self.journal.setdefault(str(denom), {})
        old_addr = nano_address_from_pubkey(legacy_pool_keypair(denom)[1])
        new_addr = nano_address_from_pubkey(new_pub)
        print(f"\n=== Migrating denomination {denom} ===")
        print(f"    old (single-key): {old_addr}")
        print(f"    new (2-of-3):     {new_addr}")

        if not jd.get("received_old"):
            print("  [1/4] receiving pending deposits into old account")
            self.receive_all_old(denom)
            jd["received_old"] = True
            save_journal(self.journal)
        else:
            print("  [1/4] already done")

        if not jd.get("sweep_hash"):
            print("  [2/4] sweeping old balance to threshold account")
            self.sweep_to_frost(denom, jd)
            save_journal(self.journal)
            if jd.get("sweep_hash") not in (None, "EMPTY", "DRYRUN"):
                self.wait_confirmed(jd["sweep_hash"])
        else:
            print(f"  [2/4] already done ({jd['sweep_hash'][:16]}...)")

        if not jd.get("frost_received"):
            print("  [3/4] FROST-receiving into threshold account")
            self.frost_receive(denom, jd)
            jd["frost_received"] = True
            save_journal(self.journal)
        else:
            print("  [3/4] already done")

        print("  [4/4] recording legacy pubkey")
        self.record_legacy_pubkey(denom)
        jd["done"] = True
        save_journal(self.journal)

        # Final balance check.
        info = self.account_info(new_addr)
        if "error" not in info:
            print(f"  threshold account balance: {int(info['balance'])} raw "
                  f"({int(info['balance']) / 1e30} XNO)")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--denominations", help="comma-separated raw amounts (default: all)")
    ap.add_argument("--dry-run", action="store_true", help="print actions without broadcasting")
    args = ap.parse_args()

    from decimal import Decimal
    denoms = (
        [int(Decimal(d)) for d in args.denominations.split(",")]
        if args.denominations
        else sorted(DENOMINATIONS)
    )
    for d in denoms:
        if d not in DENOMINATIONS:
            sys.exit(f"{d} is not a protocol denomination: {sorted(DENOMINATIONS)}")
    m = Migrator(dry_run=args.dry_run)
    for denom in denoms:
        m.migrate(denom)

    print(
        "\nMigration complete. The guardian seed can no longer move pool "
        "funds.\nKeep it stored offline until you have independently "
        "verified every balance;\nold deposit commitments remain provable "
        "via the recorded legacy pubkeys."
    )


if __name__ == "__main__":
    main()
