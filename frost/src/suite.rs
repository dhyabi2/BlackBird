//! FROST(Ed25519, Blake2b-512) ciphersuite — BlackBird's first-party
//! implementation, self-contained in this crate.
//!
//! Structurally the RFC 9591 `frost-ed25519` ciphersuite with SHA-512
//! replaced by Blake2b-512. The externally load-bearing choice is `H2`, the
//! challenge hash: it is the *unprefixed* `Blake2b-512(R ‖ A ‖ M)` reduced
//! mod ℓ — exactly what a Nano node computes when verifying a block
//! signature — so aggregated FROST signatures verify on the Nano network
//! unchanged. Every other hash is a domain-separated internal and only needs
//! to be consistent between the guardians.
//!
//! FROZEN PROTOCOL CONSTANT: `CONTEXT_STRING` (and thus `Ciphersuite::ID`)
//! is embedded in the wire/disk serialization of every key share produced by
//! the 2026-08-18 DKG ceremony. Changing it would render all deployed
//! guardian key material unreadable; a change requires a fresh DKG ceremony
//! and a full fund migration. The string's historical name comes from the
//! ceremony's original ciphersuite definition and has no other significance.

use blake2::{Blake2b512, Digest};
use curve25519_dalek::{
    constants::ED25519_BASEPOINT_POINT,
    edwards::{CompressedEdwardsY, EdwardsPoint},
    scalar::Scalar,
    traits::Identity,
};
use frost_core::{Ciphersuite, Field, FieldError, Group, GroupError};
use rand_core::{CryptoRng, RngCore};

/// Frozen: see module docs. Serialized into all deployed key material.
pub const CONTEXT_STRING: &str = "XNOXMR-FROST-ED25519-BLAKE2B-v1";

pub fn blake2b512(inputs: &[&[u8]]) -> [u8; 64] {
    let mut h = Blake2b512::new();
    for i in inputs {
        h.update(i);
    }
    h.finalize().into()
}

pub fn hash_to_scalar(inputs: &[&[u8]]) -> Scalar {
    Scalar::from_bytes_mod_order_wide(&blake2b512(inputs))
}

/// The Ed25519 scalar field.
#[derive(Clone, Copy)]
pub struct Ed25519ScalarField;

impl Field for Ed25519ScalarField {
    type Scalar = Scalar;
    type Serialization = [u8; 32];

    fn zero() -> Self::Scalar {
        Scalar::ZERO
    }

    fn one() -> Self::Scalar {
        Scalar::ONE
    }

    fn invert(scalar: &Self::Scalar) -> Result<Self::Scalar, FieldError> {
        if *scalar == Scalar::ZERO {
            Err(FieldError::InvalidZeroScalar)
        } else {
            Ok(scalar.invert())
        }
    }

    fn random<R: RngCore + CryptoRng>(rng: &mut R) -> Self::Scalar {
        Scalar::random(rng)
    }

    fn serialize(scalar: &Self::Scalar) -> Self::Serialization {
        scalar.to_bytes()
    }

    fn deserialize(buf: &Self::Serialization) -> Result<Self::Scalar, FieldError> {
        match Scalar::from_canonical_bytes(*buf).into() {
            Some(s) => Ok(s),
            None => Err(FieldError::MalformedScalar),
        }
    }

    fn little_endian_serialize(scalar: &Self::Scalar) -> Self::Serialization {
        Self::serialize(scalar)
    }
}

/// The Ed25519 prime-order group.
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct Ed25519Group;

impl Group for Ed25519Group {
    type Field = Ed25519ScalarField;
    type Element = EdwardsPoint;
    type Serialization = [u8; 32];

    fn cofactor() -> Scalar {
        Scalar::ONE
    }

    fn identity() -> Self::Element {
        EdwardsPoint::identity()
    }

    fn generator() -> Self::Element {
        ED25519_BASEPOINT_POINT
    }

    fn serialize(element: &Self::Element) -> Result<Self::Serialization, GroupError> {
        if *element == Self::identity() {
            return Err(GroupError::InvalidIdentityElement);
        }
        Ok(element.compress().to_bytes())
    }

    fn deserialize(buf: &Self::Serialization) -> Result<Self::Element, GroupError> {
        match CompressedEdwardsY::from_slice(buf.as_ref())
            .map_err(|_| GroupError::MalformedElement)?
            .decompress()
        {
            Some(point) => {
                if point == Self::identity() {
                    Err(GroupError::InvalidIdentityElement)
                } else if point.is_torsion_free() {
                    // Restricting to the prime-order subgroup also rejects
                    // every exploitable non-canonical encoding.
                    Ok(point)
                } else {
                    Err(GroupError::InvalidNonPrimeOrderElement)
                }
            }
            None => Err(GroupError::MalformedElement),
        }
    }
}

/// FROST(Ed25519, Blake2b-512), Nano-compatible at `H2`.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Ed25519Blake2b;

impl Ciphersuite for Ed25519Blake2b {
    const ID: &'static str = CONTEXT_STRING;

    type Group = Ed25519Group;
    type HashOutput = [u8; 64];
    type SignatureSerialization = [u8; 64];

    /// Binding-factor hash (domain-separated internal).
    fn H1(m: &[u8]) -> Scalar {
        hash_to_scalar(&[CONTEXT_STRING.as_bytes(), b"rho", m])
    }

    /// Challenge hash — MUST remain the raw, unprefixed
    /// `Blake2b-512(R ‖ A ‖ M) mod ℓ` so signatures verify as Nano blocks.
    fn H2(m: &[u8]) -> Scalar {
        hash_to_scalar(&[m])
    }

    /// Nonce-generation hash (domain-separated internal).
    fn H3(m: &[u8]) -> Scalar {
        hash_to_scalar(&[CONTEXT_STRING.as_bytes(), b"nonce", m])
    }

    /// Message prehash (domain-separated internal).
    fn H4(m: &[u8]) -> Self::HashOutput {
        blake2b512(&[CONTEXT_STRING.as_bytes(), b"msg", m])
    }

    /// Commitment-list prehash (domain-separated internal).
    fn H5(m: &[u8]) -> Self::HashOutput {
        blake2b512(&[CONTEXT_STRING.as_bytes(), b"com", m])
    }

    /// DKG hash (domain-separated internal).
    fn HDKG(m: &[u8]) -> Option<Scalar> {
        Some(hash_to_scalar(&[CONTEXT_STRING.as_bytes(), b"dkg", m]))
    }

    /// Identifier hash (domain-separated internal).
    fn HID(m: &[u8]) -> Option<Scalar> {
        Some(hash_to_scalar(&[CONTEXT_STRING.as_bytes(), b"id", m]))
    }
}
