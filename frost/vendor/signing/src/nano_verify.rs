//! An independent ed25519-blake2b verifier, matching what a Nano node does.
//!
//! Deliberately shares no code path with the frost-core ciphersuite beyond
//! curve25519-dalek arithmetic: challenge hashing and all input validation
//! are re-stated here from the ed25519 definition, so a signature that
//! passes both this and the FROST verifier is unlikely to pass either by
//! construction accident. The Python reference in `tests/nano_ref.py` is the
//! third, non-dalek leg of the differential battery.

use blake2::{Blake2b512, Digest};
use curve25519_dalek::{
    edwards::{CompressedEdwardsY, EdwardsPoint},
    scalar::Scalar,
};

/// Verify `signature` (R ‖ s) over `message` for `public_key`, cofactorless,
/// with strict canonical-`s` rejection (as ed25519-donna in strict mode /
/// modern Nano nodes enforce).
pub fn verify(public_key: &[u8; 32], message: &[u8], signature: &[u8; 64]) -> bool {
    let r_bytes: [u8; 32] = signature[..32].try_into().expect("split of 64");
    let s_bytes: [u8; 32] = signature[32..].try_into().expect("split of 64");

    let Some(s) = Option::<Scalar>::from(Scalar::from_canonical_bytes(s_bytes)) else {
        return false;
    };
    let Ok(compressed_r) = CompressedEdwardsY::from_slice(&r_bytes) else {
        return false;
    };
    let Some(r) = compressed_r.decompress() else {
        return false;
    };
    let Ok(compressed_a) = CompressedEdwardsY::from_slice(public_key) else {
        return false;
    };
    let Some(a) = compressed_a.decompress() else {
        return false;
    };

    let mut h = Blake2b512::new();
    h.update(r_bytes);
    h.update(public_key);
    h.update(message);
    let mut wide = [0u8; 64];
    wide.copy_from_slice(&h.finalize());
    let c = Scalar::from_bytes_mod_order_wide(&wide);

    EdwardsPoint::mul_base(&s) == r + a * c
}
