"""
Threshold signing coordinator for the VELA guardian network.

The coordinator (guardian id 1, the machine running vela_guardian) holds one
FROST key share per denomination. To sign a Nano state block hash it runs the
two-round FROST protocol with any one available cosigner (2-of-3):

  1. commit locally; POST /frost/commit to a cosigner -> its commitments
  2. build the signing package; sign locally; POST /frost/sign with the
     signing package AND the full block context -> cosigner re-verifies the
     block (and, for withdrawals, the ZK proof) before returning its share
  3. aggregate; the CLI independently verifies the joint signature before
     releasing it, and we verify once more here with ed25519_blake2b.

Cosigners are tried in order; a failure at any step restarts the ceremony
with the next cosigner (nonces are single-use and never reused across
attempts).

Environment:
  FROST_DATA_DIR    key material root (default data/frost)
  FROST_ID          this machine's participant id (default 1)
  FROST_COSIGNERS   comma-separated "id@https://host" list, e.g.
                    "2@https://cosigner2.example,3@https://cosigner3.example"
  COSIGNER_API_KEY  shared secret sent as X-VELA-API-Key
"""
import json
import os
import tempfile
import time
import uuid
from typing import List, Optional, Tuple

import requests

from . import frost_bridge
from .vela_crypto import frost_data_dir, frost_group_pubkey, verify_signature


class FrostSigningError(RuntimeError):
    pass


def _cosigners() -> List[Tuple[int, str]]:
    raw = os.environ.get("FROST_COSIGNERS", "").strip()
    out = []
    for part in raw.split(","):
        part = part.strip()
        if not part:
            continue
        cid, _, url = part.partition("@")
        out.append((int(cid), url.rstrip("/")))
    return out


def frost_enabled(denomination: int) -> bool:
    """A denomination uses threshold signing once its DKG output exists."""
    return frost_group_pubkey(denomination) is not None


class FrostSigner:
    """Signs 32-byte Nano block hashes for one denomination via 2-of-3 FROST."""

    def __init__(self, denomination: int):
        self.denomination = denomination
        self.my_id = int(os.environ.get("FROST_ID", "1"))
        d = os.path.join(frost_data_dir(), str(denomination))
        self.key_package = os.path.join(d, "key_package")
        self.public_key_package = os.path.join(d, "public_key_package")
        pub = frost_group_pubkey(denomination)
        if pub is None or not os.path.isfile(self.key_package):
            raise FrostSigningError(f"FROST key material missing for denomination {denomination}")
        self.group_pubkey = pub
        self.session = requests.Session()

    # -- cosigner HTTP -------------------------------------------------------

    def _headers(self) -> dict:
        return {"X-VELA-API-Key": os.environ.get("COSIGNER_API_KEY", "")}

    def _post(self, url: str, path: str, payload: dict, timeout: int) -> dict:
        resp = self.session.post(url + path, json=payload, headers=self._headers(), timeout=timeout)
        if resp.status_code != 200:
            raise FrostSigningError(f"cosigner {url}{path} -> {resp.status_code}: {resp.text[:300]}")
        return resp.json()

    # -- signing -------------------------------------------------------------

    def sign(self, block_hash: bytes, context: dict) -> bytes:
        """Run the FROST ceremony for one block hash.

        context is the policy payload the cosigner uses to independently
        verify what it is signing; it must contain "type" and "block" (the
        full state block fields) plus type-specific evidence (the withdrawal
        request for type "withdraw").
        """
        if len(block_hash) != 32:
            raise FrostSigningError("block hash must be 32 bytes")
        msg_hex = block_hash.hex()
        cosigners = _cosigners()
        if not cosigners:
            raise FrostSigningError("FROST_COSIGNERS not configured")

        errors = []
        for cid, url in cosigners:
            try:
                return self._sign_with(cid, url, msg_hex, context)
            except Exception as e:
                errors.append(f"cosigner {cid} ({url}): {e}")
        raise FrostSigningError("all cosigners failed: " + " | ".join(errors))

    def _sign_with(self, cid: int, url: str, msg_hex: str, context: dict) -> bytes:
        request_id = str(uuid.uuid4())
        fd, nonces_path = tempfile.mkstemp(prefix="frost-nonces-")
        os.close(fd)
        os.unlink(nonces_path)  # commit refuses to overwrite; give a fresh path
        try:
            my_commit = frost_bridge.commit(self.key_package, nonces_path)
            their = self._post(url, "/frost/commit", {
                "request_id": request_id,
                "denomination": str(self.denomination),
            }, timeout=15)
            signing_package = frost_bridge.make_signing_package(
                msg_hex, {self.my_id: my_commit, cid: their["commitments"]}
            )
            my_share = frost_bridge.sign(self.key_package, nonces_path, signing_package)
            their_sig = self._post(url, "/frost/sign", {
                "request_id": request_id,
                "denomination": str(self.denomination),
                "signing_package": signing_package,
                "context": context,
            }, timeout=120)
            signature_hex = frost_bridge.aggregate(
                self.public_key_package,
                signing_package,
                {self.my_id: my_share, cid: their_sig["signature_share"]},
            )
            signature = bytes.fromhex(signature_hex)
            # Belt and braces: the CLI already ran the independent Rust
            # verifier; check once more with the Python Nano verifier.
            if not verify_signature(self.group_pubkey, bytes.fromhex(msg_hex), signature):
                raise FrostSigningError("aggregated signature failed python verification")
            return signature
        finally:
            # If the ceremony died between commit and sign, drop the nonces.
            try:
                os.unlink(nonces_path)
            except OSError:
                pass
