"""
Bridge to Node.js Poseidon/circomlibjs helpers because Python 3.14 lacks
compatible poseidon-hash/galois/numba wheels.
"""
import json
import os
import subprocess
from typing import Any, Dict, List

SCRIPT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "scripts"))
HELPER = os.path.join(SCRIPT_DIR, "poseidon_helper.mjs")


def _run_helper(args: List[str], stdin: str = "") -> Dict[str, Any]:
    result = subprocess.run(
        ["node", HELPER] + args,
        input=stdin,
        capture_output=True,
        text=True,
        timeout=30,
    )
    if result.returncode != 0:
        raise RuntimeError(f"poseidon helper failed: {result.stderr}")
    out = result.stdout.strip()
    lines = [l for l in out.splitlines() if l.startswith("{")]
    if not lines:
        raise RuntimeError(f"poseidon helper empty output: {out}")
    return json.loads(lines[-1])


def poseidon_hash(inputs: List[int]) -> int:
    """Circom-compatible Poseidon over BN254."""
    payload = json.dumps({"action": "hash", "inputs": [str(x) for x in inputs]})
    result = _run_helper(["hash"], stdin=payload)
    return int(result["hash"])


def split32(value: bytes) -> tuple:
    """Split a 32-byte big-endian value into two BN254 field elements."""
    assert len(value) == 32
    hi = int.from_bytes(value[:16], "big")
    lo = int.from_bytes(value[16:], "big")
    return lo, hi


def combine32(lo: int, hi: int) -> bytes:
    """Combine two BN254 field element limbs back into 32 bytes."""
    return hi.to_bytes(16, "big") + lo.to_bytes(16, "big")


def poseidon_tree(leaves: List[int], depth: int = 20, leaf_index: int = 0) -> Dict[str, Any]:
    """Build a Poseidon Merkle tree (or extract proof for leaf_index)."""
    payload = {
        "action": "tree",
        "leaves": [str(x) for x in leaves],
        "depth": depth,
        "leafIndex": leaf_index,
    }
    return _run_helper(["tree"], stdin=json.dumps(payload))


def verify_poseidon_proof(root: int, leaf: int, path: List[int], indices: List[int]) -> bool:
    current = poseidon_hash([leaf, 0])
    for sibling, idx in zip(path, indices):
        if idx == 0:
            current = poseidon_hash([current, sibling])
        else:
            current = poseidon_hash([sibling, current])
    return current == root


def field_to_bytes32(value: int) -> bytes:
    return value.to_bytes(32, "big")
