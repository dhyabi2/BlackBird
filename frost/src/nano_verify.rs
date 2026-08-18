//! Independent ed25519-blake2b signature verifier.
//!
//! Deliberately shares no code path with the frost-core aggregation logic:
//! this is the release gate that checks an aggregated signature the way a
//! modern Nano node does — cofactorless equation, canonical (non-malleable)
//! `s`, and full point decompression checks.

use blake2::{Blake2b512, Digest};
use curve25519_dalek::{
    constants::ED25519_BASEPOINT_POINT,
    edwards::CompressedEdwardsY,
    scalar::Scalar,
    traits::IsIdentity,
};

/// Verify `signature` (R ‖ s, 64 bytes) over `message` for `public_key`.
///
/// Checks: canonical `s < ℓ` (rejects malleated signatures), decompressible
/// `R` and `A`, and the cofactorless equation `[s]B == R + [c]A` with
/// `c = Blake2b-512(R ‖ A ‖ M) mod ℓ`.
pub fn verify(public_key: &[u8; 32], message: &[u8], signature: &[u8; 64]) -> bool {
    let r_bytes: [u8; 32] = signature[..32].try_into().unwrap();
    let s_bytes: [u8; 32] = signature[32..].try_into().unwrap();

    // s must be canonical: rejects the (s + ℓ) malleability class.
    let s = match Option::<Scalar>::from(Scalar::from_canonical_bytes(s_bytes)) {
        Some(s) => s,
        None => return false,
    };

    let a = match CompressedEdwardsY(*public_key).decompress() {
        Some(p) => p,
        None => return false,
    };
    if a.is_identity() {
        return false;
    }
    let r = match CompressedEdwardsY(r_bytes).decompress() {
        Some(p) => p,
        None => return false,
    };

    let mut h = Blake2b512::new();
    h.update(r_bytes);
    h.update(public_key);
    h.update(message);
    let c = Scalar::from_bytes_mod_order_wide(&h.finalize().into());

    // Cofactorless: [s]B == R + [c]A, exactly as Nano nodes check.
    ED25519_BASEPOINT_POINT * s == r + a * c
}
