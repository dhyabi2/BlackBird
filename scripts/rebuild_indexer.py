"""Chain-derived indexer rebuild + verify CLI (zero secrets required).

Pattern adopted from the holdergame trustless roadmap (W2/W8: "replay is
truth", boot-from-nothing): the indexer's commitment sets are a pure function
of public chain data, so anyone can recompute them — and the operator can
rebuild `data/indexer_state.json` after total server loss.

Derivation, per denomination and per pool pubkey (current + legacy):
  pool account history receives + receivable  ->  deposit send hashes
  deposit send (confirmed, amount == denomination, link == pool pubkey)
  successor block on the depositor's chain (confirmed, 1 raw, previous ==
  deposit) -> its link IS the commitment C, epoch = local_timestamp // 86400

Every accepted block is verified LOCALLY (holdergame W9): the state block
hash is recomputed and the ed25519-blake2b signature checked against the
block's own account, so an untrusted RPC endpoint can omit data but never
forge it.

Nullifiers are NOT derivable from withdrawal blocks (the link is the
destination); they are recovered from the guardian's on-chain anchor account
(1-raw sends whose link is the nullifier) when --anchor-account is given.

Usage:
  python -m scripts.rebuild_indexer                    # verify vs data/indexer_state.json
  python -m scripts.rebuild_indexer --rebuild out.json # write indexer-format state
  python -m scripts.rebuild_indexer --roots-url http://127.0.0.1:8080
                                                       # also diff Merkle roots vs a live indexer
  python -m scripts.rebuild_indexer --anchor-account nano_...   # recover nullifiers
"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src.nano_rpc import NanoRPC
from src.vela_constants import DENOMINATIONS, EPOCH_SECONDS
from src.vela_crypto import (
    nano_address_from_pubkey,
    nano_pubkey_from_address,
    nano_state_block_hash,
    verify_signature,
)

rpc = NanoRPC()


def fetch_pool_pubkeys(pools_from: str) -> dict:
    """denomination -> [pubkey bytes, ...] (current first, then legacy)."""
    import requests

    out = {}
    for denom in sorted(DENOMINATIONS):
        r = requests.get(f"{pools_from}/api/pool_address/{denom}", timeout=20)
        r.raise_for_status()
        data = r.json()
        keys = [bytes.fromhex(data["pool_pubkey"])]
        keys += [bytes.fromhex(h) for h in data.get("legacy_pubkeys", [])]
        out[denom] = keys
    return out


def verify_block_locally(block_hash: str, info: dict) -> bool:
    """Recompute the state block hash and check the signature — the block is
    self-certifying, so the RPC endpoint never has to be trusted for content."""
    c = info.get("contents", {})
    try:
        if c.get("type") != "state":
            return False
        h = nano_state_block_hash(
            nano_pubkey_from_address(c["account"]),
            bytes.fromhex(c["previous"]),
            nano_pubkey_from_address(c["representative"]),
            int(c["balance"]),
            bytes.fromhex(c["link"]),
        )
        if h.hex().upper() != block_hash.upper():
            return False
        return verify_signature(
            nano_pubkey_from_address(c["account"]), h, bytes.fromhex(c["signature"])
        )
    except Exception:
        return False


def blocks_info(hashes: list) -> dict:
    if not hashes:
        return {}
    out = {}
    for i in range(0, len(hashes), 100):
        chunk = hashes[i : i + 100]
        data = rpc.call(
            "blocks_info",
            {"hashes": chunk, "json_block": "true", "include_not_found": "true"},
        )
        out.update(data.get("blocks", {}) or {})
    return out


def pool_deposit_hashes(address: str) -> set:
    """All deposit send hashes into a pool account: links of its receive
    blocks plus everything still receivable."""
    deposits = set()
    head = None
    while True:
        params = {"account": address, "count": 500, "raw": "true"}
        if head:
            params["head"] = head
        try:
            data = rpc.call("account_history", params)
        except Exception as e:
            if "not found" in str(e).lower():
                break
            raise
        history = data.get("history", []) or []
        if isinstance(history, str) or not history:
            break
        for entry in history:
            if entry.get("subtype") == "receive" or entry.get("type") == "receive":
                link = entry.get("link") or ""
                if len(link) == 64:
                    deposits.add(link.upper())
        head = data.get("previous")
        if not head:
            break
    try:
        pending = rpc.call(
            "receivable", {"account": address, "count": 500, "source": "true"}
        )
    except Exception:
        try:
            pending = rpc.call(
                "pending", {"account": address, "count": 500, "source": "true"}
            )
        except Exception:
            pending = {}
    blocks = pending.get("blocks", {}) or {}
    if isinstance(blocks, dict):
        deposits.update(h.upper() for h in blocks if len(h) == 64)
    return deposits


def derive_commitments(pool_keys: dict, unverified: list) -> dict:
    """(epoch, denomination) -> set of commitment ints, from chain data only."""
    commitments = {}
    for denom, pubkeys in pool_keys.items():
        valid_links = {pk.hex().upper() for pk in pubkeys}
        deposit_hashes = set()
        for pk in pubkeys:
            addr = nano_address_from_pubkey(pk)
            deposit_hashes |= pool_deposit_hashes(addr)
        infos = blocks_info(sorted(deposit_hashes))

        for dep_hash, dep in infos.items():
            c = dep.get("contents") or {}
            if not c or dep.get("confirmed") != "true":
                continue
            if int(dep.get("amount", 0) or 0) != denom:
                continue
            if (c.get("link") or "").upper() not in valid_links:
                continue
            if not verify_block_locally(dep_hash, dep):
                unverified.append(dep_hash)
                continue

            # The commitment chains directly from the deposit on the
            # depositor's own chain.
            try:
                succ = rpc.call("successors", {"block": dep_hash, "count": 2})
                chain = succ.get("blocks", []) or []
            except Exception:
                chain = []
            if len(chain) < 2:
                continue
            com_hash = chain[1]
            com = blocks_info([com_hash]).get(com_hash) or {}
            cc = com.get("contents") or {}
            if (
                not cc
                or com.get("confirmed") != "true"
                or int(com.get("amount", 0) or 0) != 1
                or (cc.get("previous") or "").upper() != dep_hash.upper()
                or cc.get("account") != c.get("account")
                or len(cc.get("link") or "") != 64
            ):
                continue
            if not verify_block_locally(com_hash, com):
                unverified.append(com_hash)
                continue

            epoch = int(dep.get("local_timestamp", 0)) // EPOCH_SECONDS
            C = int(cc["link"], 16)
            commitments.setdefault((epoch, denom), set()).add(C)
    return commitments


def derive_nullifiers(anchor_account: str, unverified: list) -> set:
    """Nullifiers from the anchor account's 1-raw sends (link = nullifier)."""
    nullifiers = set()
    head = None
    while True:
        params = {"account": anchor_account, "count": 500, "raw": "true"}
        if head:
            params["head"] = head
        try:
            data = rpc.call("account_history", params)
        except Exception as e:
            if "not found" in str(e).lower():
                break
            raise
        history = data.get("history", []) or []
        if isinstance(history, str) or not history:
            break
        hashes = [
            e["hash"]
            for e in history
            if (e.get("subtype") == "send" or e.get("type") == "send")
            and len(e.get("hash") or "") == 64
        ]
        infos = blocks_info(hashes)
        for h, info in infos.items():
            c = info.get("contents") or {}
            if info.get("confirmed") != "true" or int(info.get("amount", 0) or 0) != 1:
                continue
            if not verify_block_locally(h, info):
                unverified.append(h)
                continue
            nullifiers.add(int(c["link"], 16))
        head = data.get("previous")
        if not head:
            break
    return nullifiers


def to_state_json(commitments: dict, nullifiers: set) -> dict:
    return {
        "commitments": {
            f"{epoch}:{denom}": sorted(hex(x) for x in leaves)
            for (epoch, denom), leaves in sorted(commitments.items())
        },
        "nullifiers": sorted(format(n, "064x") for n in nullifiers),
    }


def diff_against_file(derived: dict, path: str) -> int:
    with open(path) as f:
        existing = json.load(f)
    existing_c = {
        k: set(int(x, 16) for x in v)
        for k, v in (existing.get("commitments", {}) or {}).items()
    }
    derived_c = {
        f"{epoch}:{denom}": leaves for (epoch, denom), leaves in derived.items()
    }
    issues = 0
    for key in sorted(set(existing_c) | set(derived_c)):
        have, chain = existing_c.get(key, set()), derived_c.get(key, set())
        missing_from_file = chain - have
        extra_in_file = have - chain
        if missing_from_file:
            issues += 1
            print(f"  {key}: {len(missing_from_file)} on-chain commitment(s) MISSING from state file")
        if extra_in_file:
            issues += 1
            print(f"  {key}: {len(extra_in_file)} state-file commitment(s) NOT found on chain:")
            for C in sorted(extra_in_file):
                print(f"    {hex(C)}")
        if not missing_from_file and not extra_in_file:
            print(f"  {key}: OK ({len(have)} commitment(s))")
    return issues


def diff_roots(derived: dict, roots_url: str) -> int:
    from src.vela_indexer import PoseidonMerkleTree
    import requests

    issues = 0
    for (epoch, denom), leaves in sorted(derived.items()):
        local_root = hex(PoseidonMerkleTree(sorted(leaves)).root)
        r = requests.get(f"{roots_url}/root/{epoch}/{denom}", timeout=30)
        if r.status_code != 200:
            issues += 1
            print(f"  root {epoch}:{denom}: indexer has NO tree (chain has {len(leaves)} leaves)")
            continue
        remote_root = r.json().get("root")
        status = "OK" if remote_root == local_root else "MISMATCH"
        if status != "OK":
            issues += 1
        print(f"  root {epoch}:{denom}: {status} (chain {local_root} vs indexer {remote_root})")
    return issues


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--pools-from", default="https://www.xblackbird.com",
                    help="base URL serving /api/pool_address/<denom> (default: production web)")
    ap.add_argument("--state-file", default="data/indexer_state.json",
                    help="existing indexer state to verify against")
    ap.add_argument("--rebuild", metavar="OUT",
                    help="write chain-derived state to OUT in indexer format")
    ap.add_argument("--roots-url", help="live indexer base URL to diff Merkle roots against")
    ap.add_argument("--anchor-account", help="nullifier anchor account (nano_...)")
    args = ap.parse_args()

    print(f"Resolving pool keys from {args.pools_from} ...")
    pool_keys = fetch_pool_pubkeys(args.pools_from)
    for denom, keys in sorted(pool_keys.items()):
        print(f"  denom {denom}: {len(keys)} pool key(s)")

    unverified: list = []
    print("Deriving commitments from chain data ...")
    commitments = derive_commitments(pool_keys, unverified)
    total = sum(len(v) for v in commitments.values())
    print(f"  {total} commitment(s) across {len(commitments)} (epoch, denomination) tree(s)")

    nullifiers: set = set()
    if args.anchor_account:
        print(f"Recovering nullifiers from anchor account {args.anchor_account} ...")
        nullifiers = derive_nullifiers(args.anchor_account, unverified)
        print(f"  {len(nullifiers)} nullifier(s)")

    if unverified:
        print(f"WARNING: {len(unverified)} block(s) failed LOCAL hash/signature verification and were skipped:")
        for h in unverified:
            print(f"  {h}")

    issues = 0
    if args.rebuild:
        state = to_state_json(commitments, nullifiers)
        if not args.anchor_account:
            print("WARNING: rebuilding WITHOUT nullifiers (no --anchor-account). "
                  "Deploying this state without a nullifier set allows double-spends "
                  "of already-withdrawn shields — merge the guardian's nullifier "
                  "backup before serving it.")
        with open(args.rebuild, "w") as f:
            json.dump(state, f, indent=1)
        print(f"Wrote {args.rebuild}")
    elif os.path.exists(args.state_file):
        print(f"Verifying against {args.state_file} ...")
        issues += diff_against_file(commitments, args.state_file)
    else:
        print(f"(no state file at {args.state_file}; nothing local to verify against)")

    if args.roots_url:
        print(f"Diffing Merkle roots vs {args.roots_url} ...")
        issues += diff_roots(commitments, args.roots_url)

    if issues:
        print(f"RESULT: {issues} discrepancy group(s) found")
        sys.exit(1)
    print("RESULT: chain and indexer state agree")


if __name__ == "__main__":
    main()
