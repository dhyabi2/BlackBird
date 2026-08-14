"""
Test that Python Poseidon commitment/tree building matches the Circom circuit
and that snarkjs can generate/verify a Groth16 proof for a withdrawal.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src.vela_crypto import compute_commitment, compute_nullifier
from src.poseidon_bridge import split32, poseidon_tree, field_to_bytes32
from src.snarkjs_bridge import generate_proof, verify_proof


def main():
    n = bytes.fromhex("deadbeef" * 8)
    t = bytes.fromhex("cafebabe" * 8)
    P_w = bytes.fromhex("12345678" * 4 + "87654321" * 4)
    S_pub = bytes.fromhex("abcdef01" * 8)

    C = compute_commitment(n, t, P_w, S_pub)
    N = compute_nullifier(n)
    print("C:", C)
    print("N:", N)

    leaves = [C, 12345, 67890]
    tree = poseidon_tree(leaves, depth=20, leaf_index=0)
    root = int(tree["root"])
    print("root:", root)

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
        "leafIndex": tree["indices"],
        "path": tree["path"],
    }

    print("Generating proof...")
    zk = generate_proof(input_signals)
    print("public signals:", zk["publicSignals"])

    print("Verifying proof...")
    assert verify_proof(zk["proof"], zk["publicSignals"])
    print("ZK proof verified!")


if __name__ == "__main__":
    main()
