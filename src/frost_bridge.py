"""
Python bridge to the frost-guardian CLI (frost/ crate).

Every function shells out to a stateless subcommand. Secret material stays in
files owned by this machine; only public blobs (hex strings) cross process
boundaries. See frost/src/main.rs for the underlying commands.
"""
import json
import os
import subprocess
import tempfile
from typing import Dict, Optional, Tuple

_DEFAULT_BIN = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "frost", "target", "release", "frost-guardian",
)


def frost_bin() -> str:
    return os.environ.get("FROST_GUARDIAN_BIN", _DEFAULT_BIN)


class FrostError(RuntimeError):
    pass


def _run(args: list) -> dict:
    proc = subprocess.run(
        [frost_bin()] + args,
        capture_output=True,
        text=True,
        timeout=60,
    )
    if proc.returncode != 0:
        raise FrostError(proc.stderr.strip() or f"frost-guardian exited {proc.returncode}")
    return json.loads(proc.stdout)


def _tmp_json(data: dict) -> str:
    fd, path = tempfile.mkstemp(suffix=".json", prefix="frost-")
    with os.fdopen(fd, "w") as f:
        json.dump(data, f)
    return path


def dkg_part1(participant_id: int, max_signers: int, min_signers: int, secret_out: str) -> str:
    out = _run([
        "dkg-part1",
        "--id", str(participant_id),
        "--max-signers", str(max_signers),
        "--min-signers", str(min_signers),
        "--secret-out", secret_out,
    ])
    return out["round1_package"]


def dkg_part2(secret_in: str, round1_packages: Dict[int, str], secret_out: str) -> Dict[int, str]:
    r1 = _tmp_json({str(k): v for k, v in round1_packages.items()})
    try:
        out = _run([
            "dkg-part2",
            "--secret-in", secret_in,
            "--round1", r1,
            "--secret-out", secret_out,
        ])
    finally:
        os.unlink(r1)
    return {int(k): v for k, v in out["round2_packages"].items()}


def dkg_part3(
    secret_in: str,
    round1_packages: Dict[int, str],
    round2_packages: Dict[int, str],
    key_package_out: str,
) -> Tuple[str, str]:
    """Returns (public_key_package_hex, group_pubkey_hex)."""
    r1 = _tmp_json({str(k): v for k, v in round1_packages.items()})
    r2 = _tmp_json({str(k): v for k, v in round2_packages.items()})
    try:
        out = _run([
            "dkg-part3",
            "--secret-in", secret_in,
            "--round1", r1,
            "--round2", r2,
            "--key-package-out", key_package_out,
        ])
    finally:
        os.unlink(r1)
        os.unlink(r2)
    return out["public_key_package"], out["group_pubkey"]


def commit(key_package_path: str, nonces_out: str) -> str:
    out = _run(["commit", "--key-package", key_package_path, "--nonces-out", nonces_out])
    return out["commitments"]


def make_signing_package(msg_hex: str, commitments: Dict[int, str]) -> str:
    c = _tmp_json({str(k): v for k, v in commitments.items()})
    try:
        out = _run(["signing-package", "--msg", msg_hex, "--commitments", c])
    finally:
        os.unlink(c)
    return out["signing_package"]


def sign(key_package_path: str, nonces_path: str, signing_package_hex: str) -> str:
    out = _run([
        "sign",
        "--key-package", key_package_path,
        "--nonces", nonces_path,
        "--signing-package", signing_package_hex,
    ])
    return out["signature_share"]


def aggregate(public_key_package_path: str, signing_package_hex: str, shares: Dict[int, str]) -> str:
    s = _tmp_json({str(k): v for k, v in shares.items()})
    try:
        out = _run([
            "aggregate",
            "--public-key-package", public_key_package_path,
            "--signing-package", signing_package_hex,
            "--shares", s,
        ])
    finally:
        os.unlink(s)
    return out["signature"]


def inspect_signing_package(signing_package_hex: str) -> dict:
    """Returns {"msg": hex, "signer_ids": [str]}."""
    return _run(["inspect-signing-package", "--signing-package", signing_package_hex])


def verify(pubkey_hex: str, msg_hex: str, signature_hex: str) -> bool:
    try:
        out = _run(["verify", "--pubkey", pubkey_hex, "--msg", msg_hex, "--signature", signature_hex])
        return bool(out.get("valid"))
    except FrostError:
        return False


def group_pubkey(public_key_package_path: str) -> str:
    return _run(["group-pubkey", "--public-key-package", public_key_package_path])["group_pubkey"]
