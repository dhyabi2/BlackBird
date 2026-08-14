"""
Python bridge to snarkjs for Groth16 proof generation/verification.
"""
import json
import os
import subprocess
from typing import Any, Dict, List

CIRCUIT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "circuit"))


def _bigint_safe(obj):
    """Recursively convert Python ints to decimal strings for JS BigInt safety."""
    if isinstance(obj, int):
        return str(obj)
    if isinstance(obj, list):
        return [_bigint_safe(x) for x in obj]
    if isinstance(obj, dict):
        return {k: _bigint_safe(v) for k, v in obj.items()}
    return obj


def _run_node_helper(payload: dict, timeout: int = 120) -> dict:
    helper = os.path.join(CIRCUIT_DIR, "poseidon_js", "snarkjs_helper.js")
    env = os.environ.copy()
    env["BASE_DIR"] = os.path.join(CIRCUIT_DIR, "build")
    result = subprocess.run(
        ["node", helper],
        input=json.dumps(_bigint_safe(payload)),
        capture_output=True,
        text=True,
        env=env,
        timeout=timeout,
    )
    if result.returncode != 0:
        raise RuntimeError(f"snarkjs helper failed: {result.stderr}")
    out = result.stdout.strip()
    # If node prints extra logs, find last JSON line
    lines = [l for l in out.splitlines() if l.startswith("{") or l.startswith("[")]
    if not lines:
        raise RuntimeError(f"snarkjs helper empty output: {out}")
    return json.loads(lines[-1])


def generate_proof(input_signals: Dict[str, Any]) -> Dict[str, Any]:
    payload = {"action": "prove", "input": input_signals}
    result = _run_node_helper(payload, timeout=180)
    if "error" in result:
        raise RuntimeError(result["error"])
    return result


def verify_proof(proof: Dict[str, Any], public_signals: List[Any]) -> bool:
    payload = {"action": "verify", "proof": proof, "publicSignals": public_signals}
    result = _run_node_helper(payload, timeout=60)
    if "error" in result:
        raise RuntimeError(result["error"])
    return result.get("valid", False)
