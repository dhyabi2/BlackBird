"""
Full-stack test of 2-of-3 FROST threshold signing for the pool:

  - three-participant DKG through the Python bridge (secret files per dir),
  - a real cosigner HTTP service (in-process werkzeug server) with its
    ledger view mocked,
  - the coordinator FrostSigner running the two-round ceremony over HTTP,
  - the joint signature verified with ed25519_blake2b (a Nano node's check),
  - negative cases: tampered block context, wrong API key.

Requires frost/target/release/frost-guardian to be built.
"""
import json
import os
import sys
import threading
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

DENOM = 10**30
API_KEY = "test-cosigner-key"

# Environment must be set before importing the modules under test.
_tmp = tempfile.mkdtemp(prefix="frost-test-")
COORD_DIR = os.path.join(_tmp, "g1")
COSIGNER_DIR = os.path.join(_tmp, "g2")
SPARE_DIR = os.path.join(_tmp, "g3")
os.environ["FROST_DATA_DIR"] = COORD_DIR
os.environ["FROST_ID"] = "1"
os.environ["FROST_COSIGNERS"] = "2@http://127.0.0.1:18082"
os.environ["COSIGNER_API_KEY"] = API_KEY
os.environ.setdefault("GUARDIAN_SEED", "11" * 32)

from src import frost_bridge  # noqa: E402
from src.frost_signer import FrostSigner  # noqa: E402
from src.vela_crypto import (  # noqa: E402
    nano_address_from_pubkey,
    nano_state_block_hash,
    verify_signature,
)


def run_dkg():
    """3-party 2-of-3 DKG across three local dirs; returns group pubkey hex."""
    dirs = {1: COORD_DIR, 2: COSIGNER_DIR, 3: SPARE_DIR}
    for d in dirs.values():
        os.makedirs(os.path.join(d, str(DENOM)), exist_ok=True)

    r1_pkg = {}
    for i, d in dirs.items():
        r1_pkg[i] = frost_bridge.dkg_part1(
            i, 3, 2, os.path.join(d, str(DENOM), "dkg_r1.secret")
        )

    r2_out = {}
    for i, d in dirs.items():
        peers = {j: p for j, p in r1_pkg.items() if j != i}
        r2_out[i] = frost_bridge.dkg_part2(
            os.path.join(d, str(DENOM), "dkg_r1.secret"),
            peers,
            os.path.join(d, str(DENOM), "dkg_r2.secret"),
        )

    group = set()
    for i, d in dirs.items():
        peers_r1 = {j: p for j, p in r1_pkg.items() if j != i}
        incoming = {j: pkgs[i] for j, pkgs in r2_out.items() if j != i}
        pkp, gp = frost_bridge.dkg_part3(
            os.path.join(d, str(DENOM), "dkg_r2.secret"),
            peers_r1,
            incoming,
            os.path.join(d, str(DENOM), "key_package"),
        )
        with open(os.path.join(d, str(DENOM), "public_key_package"), "w") as f:
            f.write(pkp)
        group.add(gp)
    assert len(group) == 1, f"group pubkey mismatch: {group}"
    gp = group.pop()
    for d in dirs.values():
        with open(os.path.join(d, str(DENOM), "group_pubkey"), "w") as f:
            f.write(gp + "\n")
    return gp


class FakeLedger:
    """Canned RPC responses for the cosigner's independent ledger checks."""

    def __init__(self, pool_addr: str, pool_pub_hex: str, send_hash: str, amount: int):
        self.pool_addr = pool_addr
        self.pool_pub_hex = pool_pub_hex
        self.send_hash = send_hash
        self.amount = amount

    def call(self, action, params=None):
        if action == "account_info":
            return {"error": "Account not found"}  # new pool account, unopened
        if action == "blocks_info":
            return {
                "blocks": {
                    self.send_hash: {
                        "confirmed": "true",
                        "amount": str(self.amount),
                        "contents": {"type": "state", "link": self.pool_pub_hex},
                    }
                }
            }
        raise AssertionError(f"unexpected RPC action {action}")


def start_cosigner(group_pub_hex: str, send_hash: str):
    from src.vela_cosigner import Cosigner, create_app

    cosigner = Cosigner(data_dir=COSIGNER_DIR)
    cosigner.my_id = 2
    pool_addr = nano_address_from_pubkey(bytes.fromhex(group_pub_hex))
    cosigner.rpc = FakeLedger(pool_addr, group_pub_hex, send_hash, DENOM)
    app = create_app(cosigner)

    from werkzeug.serving import make_server

    server = make_server("127.0.0.1", 18082, app)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, pool_addr


def main():
    print("=== FROST stack test ===")
    group_pub = run_dkg()
    print(f"DKG complete, group pubkey {group_pub[:16]}...")

    send_hash = "AB" * 32
    server, pool_addr = start_cosigner(group_pub, send_hash)
    print(f"cosigner listening; pool account {pool_addr}")

    pool_pub = bytes.fromhex(group_pub)
    block_fields = {
        "type": "state",
        "account": pool_addr,
        "previous": "00" * 32,
        "representative": pool_addr,
        "balance": str(DENOM),
        "link": send_hash,
    }
    block_hash = nano_state_block_hash(
        pool_pub, b"\x00" * 32, pool_pub, DENOM, bytes.fromhex(send_hash)
    )

    signer = FrostSigner(DENOM)
    sig = signer.sign(block_hash, {"type": "receive", "block": block_fields})
    assert verify_signature(pool_pub, block_hash, sig), "signature must verify"
    print("threshold receive signature verified by ed25519_blake2b: OK")

    # Negative: context describing a different block than the signed message.
    tampered = dict(block_fields, balance=str(DENOM * 2))
    try:
        signer.sign(block_hash, {"type": "receive", "block": tampered})
        raise SystemExit("FAIL: cosigner signed a tampered context")
    except Exception as e:
        assert "all cosigners failed" in str(e), f"unexpected error: {e}"
        print("tampered context refused: OK")

    # Negative: unknown context type.
    try:
        signer.sign(block_hash, {"type": "sweep_everything", "block": block_fields})
        raise SystemExit("FAIL: cosigner signed an unknown context type")
    except Exception:
        print("unknown context type refused: OK")

    # Negative: wrong API key (patch the client header only; the server keeps
    # reading the real key from the environment).
    signer._headers = lambda: {"X-VELA-API-Key": "wrong"}
    try:
        signer.sign(block_hash, {"type": "receive", "block": block_fields})
        raise SystemExit("FAIL: cosigner accepted a bad API key")
    except SystemExit:
        raise
    except Exception:
        print("bad API key refused: OK")

    server.shutdown()
    print("=== ALL FROST STACK TESTS PASSED ===")


if __name__ == "__main__":
    main()
