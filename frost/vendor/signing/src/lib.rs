//! FROST(Ed25519, Blake2b-512) signing for the trustless XNO⇄XMR DEX.
//!
//! Block 1 of the build order (see the solutions register, issue I2):
//!
//! - [`ciphersuite`]: an unmodified-`frost-core` ciphersuite substituting
//!   Blake2b-512 for SHA-512, so aggregated 2-of-2 signatures verify as
//!   ordinary Nano block signatures (ed25519-blake2b).
//! - [`adaptor`]: the thin external adaptor module — pre-signature
//!   generation/verification against an adaptor point `T = x·G`, completion
//!   with the secret `x`, and extraction of `x` from the completed on-chain
//!   signature.
//! - [`nano_verify`]: an independent ed25519-blake2b verifier (no frost-core
//!   code paths) used as the in-crate half of the differential battery.

#![allow(non_snake_case)]
#![forbid(unsafe_code)]

pub mod adaptor;
pub mod ciphersuite;
pub mod nano_verify;

pub use ciphersuite::Ed25519Blake2b;

/// A FROST(Ed25519, Blake2b-512) participant identifier.
pub type Identifier = frost_core::Identifier<Ed25519Blake2b>;
/// The signing package distributed to each participant for one signature.
pub type SigningPackage = frost_core::SigningPackage<Ed25519Blake2b>;
/// A joint Schnorr signature (Nano-compatible when H2 is the challenge).
pub type Signature = frost_core::Signature<Ed25519Blake2b>;
/// The joint verifying key (the Nano account public key).
pub type VerifyingKey = frost_core::VerifyingKey<Ed25519Blake2b>;
/// A single-signer signing key (for standalone signatures, e.g. orders).
pub type SigningKey = frost_core::SigningKey<Ed25519Blake2b>;
/// An error from the underlying FROST implementation.
pub type Error = frost_core::Error<Ed25519Blake2b>;

/// Key generation, shares and packages.
pub mod keys {
    use super::Ed25519Blake2b as E;
    pub type SecretShare = frost_core::keys::SecretShare<E>;
    pub type SigningShare = frost_core::keys::SigningShare<E>;
    pub type VerifyingShare = frost_core::keys::VerifyingShare<E>;
    pub type KeyPackage = frost_core::keys::KeyPackage<E>;
    pub type PublicKeyPackage = frost_core::keys::PublicKeyPackage<E>;
    pub type IdentifierList<'a> = frost_core::keys::IdentifierList<'a, E>;

    use alloc_types::*;
    mod alloc_types {
        pub use std::collections::BTreeMap;
    }
    use rand_core::{CryptoRng, RngCore};

    /// Generate 2-of-2 (or t-of-n) shares with a trusted dealer.
    pub fn generate_with_dealer<R: RngCore + CryptoRng>(
        max_signers: u16,
        min_signers: u16,
        identifiers: IdentifierList,
        rng: &mut R,
    ) -> Result<(BTreeMap<super::Identifier, SecretShare>, PublicKeyPackage), super::Error> {
        frost_core::keys::generate_with_dealer(max_signers, min_signers, identifiers, rng)
    }
}

/// Round 1: nonce commitments.
pub mod round1 {
    use super::Ed25519Blake2b as E;
    pub type SigningNonces = frost_core::round1::SigningNonces<E>;
    pub type SigningCommitments = frost_core::round1::SigningCommitments<E>;
    pub type NonceCommitment = frost_core::round1::NonceCommitment<E>;

    use rand_core::{CryptoRng, RngCore};

    pub fn commit<R: CryptoRng + RngCore>(
        secret: &super::keys::SigningShare,
        rng: &mut R,
    ) -> (SigningNonces, SigningCommitments) {
        frost_core::round1::commit::<E, R>(secret, rng)
    }
}

/// Round 2: signature shares (plain, non-adaptor signing).
pub mod round2 {
    use super::Ed25519Blake2b as E;
    pub type SignatureShare = frost_core::round2::SignatureShare<E>;

    pub fn sign(
        signing_package: &super::SigningPackage,
        signer_nonces: &super::round1::SigningNonces,
        key_package: &super::keys::KeyPackage,
    ) -> Result<SignatureShare, super::Error> {
        frost_core::round2::sign(signing_package, signer_nonces, key_package)
    }
}

/// Aggregate plain signature shares into a Nano-verifiable joint signature.
pub fn aggregate(
    signing_package: &SigningPackage,
    signature_shares: &std::collections::BTreeMap<Identifier, round2::SignatureShare>,
    pubkeys: &keys::PublicKeyPackage,
) -> Result<Signature, Error> {
    frost_core::aggregate(signing_package, signature_shares, pubkeys)
}
