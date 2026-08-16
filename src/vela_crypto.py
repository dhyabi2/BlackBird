"""
VELA v2 cryptography.

Contains:
- Nano-compatible addressing and Ed25519-blake2b signing.
- Ed25519 point arithmetic for stealth addresses.
- Pool/protocol unspendable account derivation.
- Poseidon-based commitments and nullifiers matching circuit/vela.circom.
"""
import hashlib
import os
import struct
from typing import Optional, Tuple

import ed25519_blake2b
import nacl.bindings

from .poseidon_bridge import poseidon_hash, split32, combine32

# Nano custom base32 alphabet
NANO_ALPHABET = "13456789abcdefghijkmnopqrstuwxyz"
NANO_CHAR_TO_VALUE = {c: i for i, c in enumerate(NANO_ALPHABET)}

# Ed25519 constants
SCALAR_BYTES = 32
POINT_BYTES = 32
ED25519_L = 0x1000000000000000000000000000000014DEF9DEA2F79CD65812631A5CF5D3ED

# Domain tags (BN254 field values for circuit)
DOMAIN_DEPOSIT = 1
DOMAIN_NULL = 2
PROTOCOL_TAG = b"VELAv2"

# Stealth domain (arbitrary bytes used outside circuit)
DOMAIN_STEALTH = b"vela/v2/stealth"


def blake2b_256(data: bytes) -> bytes:
    return hashlib.blake2b(data, digest_size=32).digest()


def blake2b_512(data: bytes) -> bytes:
    return hashlib.blake2b(data, digest_size=64).digest()


def _nano_base32_encode(data: bytes) -> str:
    """Encode bytes using the Nano-specific base32 alphabet."""
    length = len(data)
    leftover = (length * 8) % 5
    offset = 0 if leftover == 0 else 5 - leftover
    value = 0
    bits = 0
    out = []
    for byte in data:
        value = (value << 8) | byte
        bits += 8
        while bits >= 5:
            out.append(NANO_ALPHABET[(value >> (bits + offset - 5)) & 0x1F])
            bits -= 5
    if bits > 0:
        out.append(NANO_ALPHABET[(value << (5 - (bits + offset))) & 0x1F])
    return "".join(out)


def _nano_base32_decode(s: str) -> bytes:
    """Decode a Nano-specific base32 encoded string into bytes."""
    length = len(s)
    leftover = (length * 5) % 8
    offset = 0 if leftover == 0 else 8 - leftover
    value = 0
    bits = 0
    out = bytearray()
    for char in s:
        if char not in NANO_CHAR_TO_VALUE:
            raise ValueError(f"Invalid Nano base32 character: {char}")
        value = (value << 5) | NANO_CHAR_TO_VALUE[char]
        bits += 5
        if bits >= 8:
            out.append((value >> (bits + offset - 8)) & 0xFF)
            bits -= 8
    if bits > 0:
        out.append((value << (bits + offset - 8)) & 0xFF)
    if leftover != 0:
        out = out[1:]
    return bytes(out)


def nano_address_from_pubkey(pubkey: bytes) -> str:
    if len(pubkey) != POINT_BYTES:
        raise ValueError("Public key must be 32 bytes")
    encoded_pubkey = _nano_base32_encode(pubkey)
    checksum = _nano_base32_encode(
        hashlib.blake2b(pubkey, digest_size=5).digest()[::-1]
    )
    return "nano_" + encoded_pubkey + checksum


def nano_pubkey_from_address(address: str) -> bytes:
    if address.startswith("nano_"):
        payload = address[5:]
    elif address.startswith("xrb_"):
        payload = address[4:]
    else:
        raise ValueError("Invalid Nano address prefix")
    if len(payload) != 60:
        raise ValueError("Invalid Nano address length")
    pubkey = _nano_base32_decode(payload[:52])
    if len(pubkey) != POINT_BYTES:
        raise ValueError("Invalid Nano address payload")
    expected_checksum = _nano_base32_encode(
        hashlib.blake2b(pubkey, digest_size=5).digest()[::-1]
    )
    if payload[52:] != expected_checksum:
        raise ValueError("Invalid Nano address checksum")
    return pubkey


# ---------------------------------------------------------------------------
# Standard Nano accounts (seed -> signing key)
# ---------------------------------------------------------------------------


def nano_seed_to_keypair(seed: bytes, index: int = 0) -> Tuple[ed25519_blake2b.SigningKey, bytes]:
    """Derive a Nano keypair from a 32-byte seed and BIP32-like index."""
    data = seed + struct.pack(">I", index)
    priv_seed = hashlib.blake2b(data, digest_size=32).digest()
    sk = ed25519_blake2b.SigningKey(priv_seed)
    vk = sk.get_verifying_key()
    return sk, vk.to_bytes()


def sign_message(sk: ed25519_blake2b.SigningKey, message: bytes) -> bytes:
    return sk.sign(message)


def verify_signature(pubkey: bytes, message: bytes, signature: bytes) -> bool:
    try:
        vk = ed25519_blake2b.VerifyingKey(pubkey)
        vk.verify(signature, message)
        return True
    except Exception:
        return False


# ---------------------------------------------------------------------------
# Ed25519 scalar/point helpers for stealth addresses and pool keys
# ---------------------------------------------------------------------------


def scalar_reduce(hash_bytes: bytes) -> bytes:
    """Reduce 64 bytes to a valid Ed25519 scalar."""
    return nacl.bindings.crypto_core_ed25519_scalar_reduce(hash_bytes)


def scalar_from_seed(seed: bytes) -> bytes:
    """Clamp the Blake2b-512 hash of a seed to produce an Ed25519 scalar."""
    h = blake2b_512(seed)
    return nacl.bindings.crypto_core_ed25519_scalar_reduce(h)


def pubkey_from_scalar(scalar: bytes) -> bytes:
    """Compute public key point from scalar (scalar * G)."""
    return nacl.bindings.crypto_scalarmult_ed25519_base_noclamp(scalar)


def point_add(p: bytes, q: bytes) -> bytes:
    return nacl.bindings.crypto_core_ed25519_add(p, q)


def scalar_multiply(scalar: bytes, point: bytes) -> bytes:
    """Compute scalar * point without clamping."""
    return nacl.bindings.crypto_scalarmult_ed25519_noclamp(scalar, point)


def scalar_add(a: bytes, b: bytes) -> bytes:
    return nacl.bindings.crypto_core_ed25519_scalar_add(a, b)


def is_valid_point(point: bytes) -> bool:
    return nacl.bindings.crypto_core_ed25519_is_valid_point(point)


# ---------------------------------------------------------------------------
# Stealth addresses
# ---------------------------------------------------------------------------


def derive_view_spend(seed_view: bytes) -> Tuple[bytes, bytes, bytes, bytes]:
    """Return (a, A, b, B) from view seed."""
    a = scalar_from_seed(seed_view + b"scan")
    A = pubkey_from_scalar(a)
    b = scalar_from_seed(seed_view + b"spend")
    B = pubkey_from_scalar(b)
    return a, A, b, B


def stealth_address(A: bytes, B: bytes, r: Optional[bytes] = None) -> Tuple[bytes, bytes, bytes]:
    """Generate (R, P, H_s)."""
    if r is None:
        r = scalar_from_seed(os.urandom(64))
    R = pubkey_from_scalar(r)
    rA = scalar_multiply(r, A)
    shared = blake2b_256(DOMAIN_STEALTH + rA)
    H_s = scalar_reduce(shared + shared)
    Hs_G = pubkey_from_scalar(H_s)
    P = point_add(Hs_G, B)
    return R, P, H_s


def scan_stealth(a: bytes, b: bytes, R: bytes) -> Tuple[bytes, bytes]:
    """Scan tag R and return (P, p_scalar)."""
    aR = scalar_multiply(a, R)
    shared = blake2b_256(DOMAIN_STEALTH + aR)
    H_s = scalar_reduce(shared + shared)
    p = scalar_add(H_s, b)
    P = pubkey_from_scalar(p)
    return P, p


def sign_with_scalar(message: bytes, scalar: bytes, pubkey: bytes) -> bytes:
    """
    Sign a message with a raw Ed25519 scalar using Blake2b (Nano variant).
    """
    prefix = blake2b_512(scalar)[32:]
    r = int.from_bytes(
        nacl.bindings.crypto_core_ed25519_scalar_reduce(blake2b_512(prefix + message)),
        "little",
    )
    R = pubkey_from_scalar(r.to_bytes(32, "little"))
    h = int.from_bytes(
        nacl.bindings.crypto_core_ed25519_scalar_reduce(blake2b_512(R + pubkey + message)),
        "little",
    )
    s = (r + h * int.from_bytes(scalar, "little")) % ED25519_L
    return R + s.to_bytes(32, "little")


# ---------------------------------------------------------------------------
# Pool / protocol accounts
# ---------------------------------------------------------------------------


def hash_to_edwards(data: bytes, max_attempts: int = 10000) -> bytes:
    counter = 0
    while counter < max_attempts:
        h = blake2b_256(data + counter.to_bytes(4, "big"))
        if is_valid_point(h):
            return h
        counter += 1
    raise RuntimeError("Failed to find valid Ed25519 point")


def pool_pubkey(denomination: int) -> bytes:
    return hash_to_edwards(b"vela/v2/pool" + str(denomination).encode())


def pool_address(denomination: int) -> str:
    return nano_address_from_pubkey(pool_pubkey(denomination))


def protocol_data_account() -> str:
    return nano_address_from_pubkey(hash_to_edwards(DOMAIN_STEALTH + PROTOCOL_TAG))


# ---------------------------------------------------------------------------
# Nano state block hashing
# ---------------------------------------------------------------------------


def nano_state_block_hash(
    account: bytes,
    previous: bytes,
    representative: bytes,
    balance: int,
    link: bytes,
) -> bytes:
    """Hash a Nano state block (32-byte preamble ending in 0x06)."""
    preamble = b"\x00" * 31 + b"\x06"
    balance_bytes = balance.to_bytes(16, "big")
    data = preamble + account + previous + representative + balance_bytes + link
    return hashlib.blake2b(data, digest_size=32).digest()


def sign_block(sk: ed25519_blake2b.SigningKey, block_hash: bytes) -> bytes:
    return sk.sign(block_hash)


def raw_to_nano(raw: int) -> float:
    return raw / 1e30


# ---------------------------------------------------------------------------
# Poseidon commitments / nullifiers (match circuit/vela.circom)
# ---------------------------------------------------------------------------


def compute_commitment(n: bytes, t: bytes, P_w: bytes, S_pub: bytes) -> int:
    """Poseidon(9) commitment: DOMAIN_DEPOSIT, n_lo, n_hi, t_lo, t_hi, P_w limbs, S_pub limbs."""
    n_lo, n_hi = split32(n)
    t_lo, t_hi = split32(t)
    P_w_lo, P_w_hi = split32(P_w)
    S_pub_lo, S_pub_hi = split32(S_pub)
    return poseidon_hash([
        DOMAIN_DEPOSIT,
        n_lo, n_hi,
        t_lo, t_hi,
        P_w_lo, P_w_hi,
        S_pub_lo, S_pub_hi,
    ])


def compute_nullifier(n: bytes) -> int:
    """Poseidon(3) nullifier: DOMAIN_NULL, n_lo, n_hi."""
    n_lo, n_hi = split32(n)
    return poseidon_hash([DOMAIN_NULL, n_lo, n_hi])


def secret_from_seed(seed: bytes) -> bytes:
    return blake2b_256(seed)[:32]
