//! FROST(Ed25519, Blake2b-512) ciphersuite.
//!
//! Structurally identical to the RFC 9591 `frost-ed25519` ciphersuite with
//! SHA-512 replaced by Blake2b-512 and a distinct context string. The one
//! externally-load-bearing choice is `H2`: it is the *unprefixed*
//! `Blake2b-512(R ‖ A ‖ M)` reduced mod ℓ — exactly the challenge a Nano node
//! computes when verifying a block signature — so aggregated FROST signatures
//! verify on the Nano network unchanged. All other hashes are domain-separated
//! internals and only need to be consistent between participants.

use blake2::{Blake2b512, Digest};
use curve25519_dalek::{
    constants::ED25519_BASEPOINT_POINT,
    edwards::{CompressedEdwardsY, EdwardsPoint},
    scalar::Scalar,
    traits::Identity,
};
use frost_core::{Ciphersuite, Field, FieldError, Group, GroupError};
use rand_core::{CryptoRng, RngCore};

/// The scalar field of the FROST(Ed25519, Blake2b-512) ciphersuite.
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
        // Scalar's Eq is constant-time (ConstantTimeEq).
        if *scalar == <Self as Field>::zero() {
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

/// The Ed25519 group for the FROST(Ed25519, Blake2b-512) ciphersuite.
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct Ed25519Group;

impl Group for Ed25519Group {
    type Field = Ed25519ScalarField;
    type Element = EdwardsPoint;
    type Serialization = [u8; 32];

    fn cofactor() -> <Self::Field as Field>::Scalar {
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
                    // Rejecting non-prime-order elements also rejects every
                    // exploitable non-canonical encoding (eprint 2020/1244).
                    Ok(point)
                } else {
                    Err(GroupError::InvalidNonPrimeOrderElement)
                }
            }
            None => Err(GroupError::MalformedElement),
        }
    }
}

pub(crate) fn hash_to_array(inputs: &[&[u8]]) -> [u8; 64] {
    let mut h = Blake2b512::new();
    for i in inputs {
        h.update(i);
    }
    let mut output = [0u8; 64];
    output.copy_from_slice(h.finalize().as_slice());
    output
}

pub(crate) fn hash_to_scalar(inputs: &[&[u8]]) -> Scalar {
    Scalar::from_bytes_mod_order_wide(&hash_to_array(inputs))
}

/// Context string for every domain-separated internal hash.
const CONTEXT_STRING: &str = "XNOXMR-FROST-ED25519-BLAKE2B-v1";

/// The FROST(Ed25519, Blake2b-512) ciphersuite, Nano-compatible at `H2`.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Ed25519Blake2b;

impl Ciphersuite for Ed25519Blake2b {
    const ID: &'static str = CONTEXT_STRING;

    type Group = Ed25519Group;
    type HashOutput = [u8; 64];
    type SignatureSerialization = [u8; 64];

    /// H1 (binding-factor hash), domain-separated.
    fn H1(m: &[u8]) -> Scalar {
        hash_to_scalar(&[CONTEXT_STRING.as_bytes(), b"rho", m])
    }

    /// H2 — the challenge hash. MUST stay the raw, unprefixed
    /// `Blake2b-512(R ‖ A ‖ M) mod ℓ` for Nano network compatibility.
    fn H2(m: &[u8]) -> Scalar {
        hash_to_scalar(&[m])
    }

    /// H3 (nonce generation), domain-separated.
    fn H3(m: &[u8]) -> Scalar {
        hash_to_scalar(&[CONTEXT_STRING.as_bytes(), b"nonce", m])
    }

    /// H4 (message prehash), domain-separated.
    fn H4(m: &[u8]) -> Self::HashOutput {
        hash_to_array(&[CONTEXT_STRING.as_bytes(), b"msg", m])
    }

    /// H5 (commitment-list prehash), domain-separated.
    fn H5(m: &[u8]) -> Self::HashOutput {
        hash_to_array(&[CONTEXT_STRING.as_bytes(), b"com", m])
    }

    /// HDKG, domain-separated.
    fn HDKG(m: &[u8]) -> Option<Scalar> {
        Some(hash_to_scalar(&[CONTEXT_STRING.as_bytes(), b"dkg", m]))
    }

    /// HID, domain-separated.
    fn HID(m: &[u8]) -> Option<Scalar> {
        Some(hash_to_scalar(&[CONTEXT_STRING.as_bytes(), b"id", m]))
    }
}
