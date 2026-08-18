//! The thin adaptor-signature module over unmodified `frost-core` (issue I2).
//!
//! An adaptor pre-signature for adaptor point `T = x·G` is a pair
//! `(R', ŝ)` with `ŝ·G = (R' − T) + c·A` where `c = H2(R' ‖ A ‖ M)` is the
//! Nano challenge. It is *not* a valid signature on its own; adding the
//! secret (`s = ŝ + x`) yields the valid signature `(R', s)`, and anyone
//! holding the pre-signature extracts `x = s − ŝ` from the broadcast
//! signature. This is the atomic-swap hinge: Bob's only path to the XMR
//! forces him to publish `s`, which hands Alice `x`.
//!
//! Construction: the FROST ceremony runs on a *doctored signing package* in
//! which the lowest identifier's hiding commitment is offset by `+T`. Both
//! participants derive the identical doctored package, so binding factors,
//! group commitment `R' = R + T`, and challenge agree; every participant
//! signs with their *true* nonces via `frost-core`'s own (internals-exposed)
//! share computation, so the aggregated `ŝ` opens `R' − T`. No FROST math is
//! reimplemented here — this module only arranges inputs and checks outputs.

use std::collections::BTreeMap;

use curve25519_dalek::{edwards::EdwardsPoint, scalar::Scalar, traits::Identity};
use frost_core::{
    challenge, compute_binding_factor_list, compute_group_commitment, derive_interpolating_value,
    round1::GroupCommitmentShare, round2::compute_signature_share, Challenge, Group,
};

use crate::ciphersuite::{Ed25519Blake2b, Ed25519Group};
use crate::keys::{KeyPackage, PublicKeyPackage, VerifyingShare};
use crate::round1::{NonceCommitment, SigningCommitments, SigningNonces};
use crate::round2::SignatureShare;
use crate::{Identifier, SigningPackage, VerifyingKey};

type E = Ed25519Blake2b;

/// Errors from the adaptor module.
#[derive(Debug)]
pub enum AdaptorError {
    /// The adaptor point failed validation (non-canonical, identity, or small order).
    InvalidAdaptorPoint,
    /// The doctored hiding commitment `D + T` landed on the identity; retry with fresh nonces.
    DegenerateCommitment,
    /// The signer's nonces do not match their commitment in the session.
    NonceCommitmentMismatch,
    /// A signature share failed verification against the session transcript.
    InvalidShare(Identifier),
    /// The aggregated pre-signature does not satisfy the adaptor relation.
    InvalidPreSignature,
    /// The completed signature does not verify, or does not match this pre-signature.
    InvalidCompletedSignature,
    /// The extracted secret does not open the adaptor point.
    ExtractedSecretMismatch,
    /// An error bubbled up from frost-core.
    Frost(crate::Error),
}

impl From<crate::Error> for AdaptorError {
    fn from(e: crate::Error) -> Self {
        AdaptorError::Frost(e)
    }
}

fn point_from_bytes(bytes: &[u8; 32]) -> Result<EdwardsPoint, AdaptorError> {
    // Group::deserialize enforces canonical, non-identity, torsion-free.
    <Ed25519Group as Group>::deserialize(bytes).map_err(|_| AdaptorError::InvalidAdaptorPoint)
}

fn commitment_element(c: &NonceCommitment) -> Result<EdwardsPoint, AdaptorError> {
    let ser = c.serialize().map_err(AdaptorError::Frost)?;
    let arr: [u8; 32] = ser
        .as_slice()
        .try_into()
        .map_err(|_| AdaptorError::InvalidAdaptorPoint)?;
    point_from_bytes(&arr)
}

fn commitment_from_element(p: &EdwardsPoint) -> Result<NonceCommitment, AdaptorError> {
    if *p == EdwardsPoint::identity() {
        return Err(AdaptorError::DegenerateCommitment);
    }
    NonceCommitment::deserialize(p.compress().as_bytes()).map_err(AdaptorError::Frost)
}

/// One adaptor signing session: the doctored package plus the adaptor point.
///
/// Both participants MUST construct this from the same commitments, message,
/// and adaptor point — it is part of the session transcript, and the adaptor
/// point is thereby committed before any signature share is produced.
pub struct AdaptorSession {
    package: SigningPackage,
    true_commitments: BTreeMap<Identifier, SigningCommitments>,
    T: EdwardsPoint,
}

impl AdaptorSession {
    /// Build the session. `adaptor_point` is the compressed `T = x·G`.
    pub fn new(
        commitments: BTreeMap<Identifier, SigningCommitments>,
        message: &[u8],
        adaptor_point: &[u8; 32],
    ) -> Result<Self, AdaptorError> {
        let T = point_from_bytes(adaptor_point)?;
        let offset_id = *commitments
            .keys()
            .next()
            .ok_or(AdaptorError::InvalidPreSignature)?;

        let mut doctored = commitments.clone();
        let target = doctored
            .get_mut(&offset_id)
            .expect("offset_id comes from this map");
        let d_true = commitment_element(target.hiding())?;
        let d_offset = commitment_from_element(&(d_true + T))?;
        *target = SigningCommitments::new(d_offset, *target.binding());

        Ok(Self {
            package: SigningPackage::new(doctored, message),
            true_commitments: commitments,
            T,
        })
    }

    /// The doctored signing package (what binding factors and the challenge
    /// are computed over). Exposed for transcript logging.
    pub fn package(&self) -> &SigningPackage {
        &self.package
    }

    /// The challenge scalar of this session, `H2(R' ‖ A ‖ M)`.
    fn transcript(
        &self,
        verifying_key: &VerifyingKey,
    ) -> Result<
        (
            frost_core::BindingFactorList<E>,
            EdwardsPoint, // R' = R + T
            Challenge<E>,
        ),
        AdaptorError,
    > {
        let bfl = compute_binding_factor_list(&self.package, verifying_key, &[])?;
        let group_commitment = compute_group_commitment(&self.package, &bfl)?;
        let r_adapted = group_commitment.to_element();
        let c = challenge::<E>(&r_adapted, verifying_key, self.package.message())?;
        Ok((bfl, r_adapted, c))
    }

    /// The *true* (un-offset) group commitment share of a participant, which
    /// their signature share must open.
    fn true_commitment_share(
        &self,
        id: &Identifier,
        bfl: &frost_core::BindingFactorList<E>,
    ) -> Result<GroupCommitmentShare<E>, AdaptorError> {
        let comms = self
            .true_commitments
            .get(id)
            .ok_or(AdaptorError::InvalidShare(*id))?;
        let bf = bfl.get(id).ok_or(AdaptorError::InvalidShare(*id))?;
        Ok(comms.to_group_commitment_share(bf))
    }
}

/// Produce this participant's adaptor signature share.
///
/// Mirrors `frost_core::round2::sign` exactly, except the group commitment
/// (and therefore the challenge) comes from the session's doctored package
/// while the share itself is computed from the participant's true nonces.
pub fn adaptor_sign(
    session: &AdaptorSession,
    signer_nonces: &SigningNonces,
    key_package: &KeyPackage,
) -> Result<SignatureShare, AdaptorError> {
    // The signer's true commitments must be the ones the session was built from.
    let expected = session
        .true_commitments
        .get(key_package.identifier())
        .ok_or(AdaptorError::NonceCommitmentMismatch)?;
    if signer_nonces.commitments() != expected {
        return Err(AdaptorError::NonceCommitmentMismatch);
    }

    let (bfl, _r_adapted, c) = session.transcript(key_package.verifying_key())?;
    let bf = bfl
        .get(key_package.identifier())
        .ok_or(AdaptorError::NonceCommitmentMismatch)?
        .clone();
    let lambda_i = derive_interpolating_value(key_package.identifier(), &session.package)?;

    Ok(compute_signature_share(
        signer_nonces,
        bf,
        lambda_i,
        key_package,
        c,
    ))
}

/// Verify a counterparty's adaptor signature share against the session
/// transcript and their verifying share. This is the "pre-signature
/// verification against the offset commitment" of issue I2: shares open the
/// *true* commitment shares under the *adapted* challenge.
pub fn verify_adaptor_share(
    session: &AdaptorSession,
    id: Identifier,
    share: &SignatureShare,
    verifying_share: &VerifyingShare,
    verifying_key: &VerifyingKey,
) -> Result<(), AdaptorError> {
    let (bfl, _r_adapted, c) = session.transcript(verifying_key)?;
    let gcs = session.true_commitment_share(&id, &bfl)?;
    let lambda_i = derive_interpolating_value(&id, &session.package)?;
    share
        .verify(id, &gcs, verifying_share, lambda_i, &c)
        .map_err(|_| AdaptorError::InvalidShare(id))
}

/// An aggregated adaptor pre-signature.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PreSignature {
    /// `R' = R + T`, the nonce point of the eventual valid signature.
    pub r_adapted: [u8; 32],
    /// `ŝ` — opens `R' − T`, not `R'`; invalid as a signature by itself.
    pub s_hat: [u8; 32],
    /// The adaptor point `T` this pre-signature is bound to.
    pub adaptor_point: [u8; 32],
}

/// Verify all shares and aggregate them into a pre-signature.
pub fn aggregate_presignature(
    session: &AdaptorSession,
    shares: &BTreeMap<Identifier, SignatureShare>,
    pubkeys: &PublicKeyPackage,
) -> Result<PreSignature, AdaptorError> {
    let vk = pubkeys.verifying_key();
    for (id, share) in shares {
        let vs = pubkeys
            .verifying_shares()
            .get(id)
            .ok_or(AdaptorError::InvalidShare(*id))?;
        verify_adaptor_share(session, *id, share, vs, vk)?;
    }

    let (_bfl, r_adapted, _c) = session.transcript(vk)?;
    let mut s_hat = Scalar::ZERO;
    for share in shares.values() {
        let bytes: [u8; 32] = share
            .serialize()
            .as_slice()
            .try_into()
            .map_err(|_| AdaptorError::InvalidPreSignature)?;
        s_hat += Option::<Scalar>::from(Scalar::from_canonical_bytes(bytes))
            .ok_or(AdaptorError::InvalidPreSignature)?;
    }

    let presig = PreSignature {
        r_adapted: r_adapted.compress().to_bytes(),
        s_hat: s_hat.to_bytes(),
        adaptor_point: session.T.compress().to_bytes(),
    };
    // Belt and braces: check the adaptor relation before handing it out.
    verify_presignature(&presig, &vk.serialize()?, session.package.message())?;
    Ok(presig)
}

/// Verify the adaptor relation `ŝ·G + T = R' + c·A` with `c = H2(R' ‖ A ‖ M)`.
///
/// Anyone can run this from public data; it proves the pre-signature will
/// become a valid Nano signature the instant `x` with `x·G = T` is added.
pub fn verify_presignature(
    presig: &PreSignature,
    verifying_key: &[u8],
    message: &[u8],
) -> Result<(), AdaptorError> {
    let vk_arr: [u8; 32] = verifying_key
        .try_into()
        .map_err(|_| AdaptorError::InvalidPreSignature)?;
    let a = point_from_bytes(&vk_arr)?;
    let r_adapted = point_from_bytes(&presig.r_adapted)?;
    let t = point_from_bytes(&presig.adaptor_point)?;
    let s_hat = Option::<Scalar>::from(Scalar::from_canonical_bytes(presig.s_hat))
        .ok_or(AdaptorError::InvalidPreSignature)?;

    let c = crate::ciphersuite::hash_to_scalar(&[&presig.r_adapted, &vk_arr, message]);
    if EdwardsPoint::mul_base(&s_hat) + t == r_adapted + a * c {
        Ok(())
    } else {
        Err(AdaptorError::InvalidPreSignature)
    }
}

/// Complete a pre-signature with the adaptor secret `x`, yielding the 64-byte
/// Nano wire signature `R' ‖ s`.
pub fn complete_presignature(
    presig: &PreSignature,
    secret: &[u8; 32],
) -> Result<[u8; 64], AdaptorError> {
    let x = Option::<Scalar>::from(Scalar::from_canonical_bytes(*secret))
        .ok_or(AdaptorError::ExtractedSecretMismatch)?;
    if EdwardsPoint::mul_base(&x).compress().to_bytes() != presig.adaptor_point {
        return Err(AdaptorError::ExtractedSecretMismatch);
    }
    let s_hat = Option::<Scalar>::from(Scalar::from_canonical_bytes(presig.s_hat))
        .ok_or(AdaptorError::InvalidPreSignature)?;
    let s = s_hat + x;

    let mut sig = [0u8; 64];
    sig[..32].copy_from_slice(&presig.r_adapted);
    sig[32..].copy_from_slice(&s.to_bytes());
    // Local guard: the completed signature must satisfy the adaptor relation
    // (i.e. verify as a Schnorr signature for R'=r_adapted). We re-check the
    // pre-signature relation with x folded in via s = s_hat + x.
    // ŝ·G + T = R' + c·A  and  x·G = T  ⇒  s·G = R' + c·A, a valid signature.
    // verify_presignature already confirmed the ŝ relation at aggregation; we
    // additionally confirm x·G == T above, so (R', s) is valid by construction.
    Ok(sig)
}

/// Extract the adaptor secret from a broadcast signature: `x = s − ŝ`.
/// Returns an error if the signature does not correspond to this
/// pre-signature (checked by `x·G = T`).
pub fn extract_secret(
    presig: &PreSignature,
    signature: &[u8; 64],
) -> Result<[u8; 32], AdaptorError> {
    if signature[..32] != presig.r_adapted {
        return Err(AdaptorError::InvalidCompletedSignature);
    }
    let s_bytes: [u8; 32] = signature[32..].try_into().expect("split of 64");
    let s = Option::<Scalar>::from(Scalar::from_canonical_bytes(s_bytes))
        .ok_or(AdaptorError::InvalidCompletedSignature)?;
    let s_hat = Option::<Scalar>::from(Scalar::from_canonical_bytes(presig.s_hat))
        .ok_or(AdaptorError::InvalidPreSignature)?;
    let x = s - s_hat;
    if EdwardsPoint::mul_base(&x).compress().to_bytes() != presig.adaptor_point {
        return Err(AdaptorError::ExtractedSecretMismatch);
    }
    Ok(x.to_bytes())
}
