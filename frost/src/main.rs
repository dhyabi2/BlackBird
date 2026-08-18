//! frost-guardian: stateless CLI for FROST(Ed25519, Blake2b-512) threshold
//! signing of Nano state blocks.
//!
//! Each subcommand reads/writes hex-encoded frost-core wire blobs. Secret
//! material (DKG secret packages, key packages, signing nonces) lives in
//! files created with mode 0600; public material goes to stdout as JSON.
//!
//! Nonce files are deleted the moment a signature share is produced: reusing
//! signing nonces across two messages leaks the key share.

#![allow(non_snake_case)]
#![forbid(unsafe_code)]

use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

use clap::{Parser, Subcommand};
use rand_core::OsRng;
use serde_json::json;

mod nano_verify;
mod suite;

use suite::Ed25519Blake2b as E;

type Identifier = frost_core::Identifier<E>;
type DkgR1Secret = frost_core::keys::dkg::round1::SecretPackage<E>;
type DkgR1Package = frost_core::keys::dkg::round1::Package<E>;
type DkgR2Secret = frost_core::keys::dkg::round2::SecretPackage<E>;
type DkgR2Package = frost_core::keys::dkg::round2::Package<E>;
type KeyPackage = frost_core::keys::KeyPackage<E>;
type PublicKeyPackage = frost_core::keys::PublicKeyPackage<E>;
type SigningNonces = frost_core::round1::SigningNonces<E>;
type SigningCommitments = frost_core::round1::SigningCommitments<E>;
type SigningPackage = frost_core::SigningPackage<E>;
type SignatureShare = frost_core::round2::SignatureShare<E>;

#[derive(Parser)]
#[command(name = "frost-guardian", version, about)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// DKG round 1: generate this participant's commitment package.
    DkgPart1 {
        #[arg(long)]
        id: u16,
        #[arg(long, default_value_t = 3)]
        max_signers: u16,
        #[arg(long, default_value_t = 2)]
        min_signers: u16,
        /// File to write this round's secret state to (mode 0600).
        #[arg(long)]
        secret_out: PathBuf,
    },
    /// DKG round 2: process all peers' round-1 packages.
    DkgPart2 {
        #[arg(long)]
        secret_in: PathBuf,
        /// JSON file: {"<peer id>": "<round1 package hex>", ...} (peers only, not self).
        #[arg(long)]
        round1: PathBuf,
        #[arg(long)]
        secret_out: PathBuf,
    },
    /// DKG round 3: derive the long-lived key share and group public key.
    DkgPart3 {
        #[arg(long)]
        secret_in: PathBuf,
        #[arg(long)]
        round1: PathBuf,
        /// JSON file: {"<peer id>": "<round2 package hex addressed to us>", ...}.
        #[arg(long)]
        round2: PathBuf,
        /// File to write the long-lived secret key package to (mode 0600).
        #[arg(long)]
        key_package_out: PathBuf,
    },
    /// Signing round 1: generate nonces (secret, to file) and commitments (public).
    Commit {
        #[arg(long)]
        key_package: PathBuf,
        #[arg(long)]
        nonces_out: PathBuf,
    },
    /// Build the signing package binding a message to all commitments.
    SigningPackage {
        /// Message hex (a 32-byte Nano state block hash).
        #[arg(long)]
        msg: String,
        /// JSON file: {"<id>": "<commitments hex>", ...} for every participant.
        #[arg(long)]
        commitments: PathBuf,
    },
    /// Signing round 2: produce a signature share. Deletes the nonces file.
    Sign {
        #[arg(long)]
        key_package: PathBuf,
        #[arg(long)]
        nonces: PathBuf,
        /// Signing package hex.
        #[arg(long)]
        signing_package: String,
    },
    /// Aggregate signature shares into a Nano-verifiable 64-byte signature.
    Aggregate {
        #[arg(long)]
        public_key_package: PathBuf,
        #[arg(long)]
        signing_package: String,
        /// JSON file: {"<id>": "<signature share hex>", ...}.
        #[arg(long)]
        shares: PathBuf,
    },
    /// Verify a 64-byte signature with the independent ed25519-blake2b verifier.
    Verify {
        /// 32-byte group public key hex.
        #[arg(long)]
        pubkey: String,
        #[arg(long)]
        msg: String,
        #[arg(long)]
        signature: String,
    },
    /// Print the 32-byte group public key from a public key package.
    GroupPubkey {
        #[arg(long)]
        public_key_package: PathBuf,
    },
    /// Print the message and participant ids a signing package commits to.
    /// Cosigners use this to check the message equals the block hash they
    /// computed themselves before contributing a signature share.
    InspectSigningPackage {
        #[arg(long)]
        signing_package: String,
    },
}

fn die(msg: &str) -> ! {
    eprintln!("error: {msg}");
    std::process::exit(1)
}

fn ident(id: u16) -> Identifier {
    Identifier::try_from(id).unwrap_or_else(|_| die("identifier must be 1..=65535"))
}

/// Recover the small integer id from an Identifier (a scalar serialized
/// little-endian; guardian ids are 1..=65535 so two bytes suffice).
fn ident_to_u16(id: &Identifier) -> u16 {
    let b = id.serialize();
    u16::from_le_bytes([b[0], b[1]])
}

fn write_secret(path: &Path, bytes: &[u8]) {
    let mut f = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .unwrap_or_else(|e| die(&format!("cannot create {} (refusing to overwrite): {e}", path.display())));
    f.write_all(hex::encode(bytes).as_bytes())
        .unwrap_or_else(|e| die(&format!("write {}: {e}", path.display())));
}

fn read_hex_file(path: &Path) -> Vec<u8> {
    let s = fs::read_to_string(path)
        .unwrap_or_else(|e| die(&format!("read {}: {e}", path.display())));
    hex::decode(s.trim()).unwrap_or_else(|e| die(&format!("bad hex in {}: {e}", path.display())))
}

fn read_hex_map(path: &Path) -> BTreeMap<Identifier, Vec<u8>> {
    let s = fs::read_to_string(path)
        .unwrap_or_else(|e| die(&format!("read {}: {e}", path.display())));
    let raw: BTreeMap<String, String> =
        serde_json::from_str(&s).unwrap_or_else(|e| die(&format!("bad JSON in {}: {e}", path.display())));
    raw.into_iter()
        .map(|(k, v)| {
            let id: u16 = k.parse().unwrap_or_else(|_| die("map keys must be participant ids"));
            let bytes = hex::decode(v.trim()).unwrap_or_else(|e| die(&format!("bad hex for id {id}: {e}")));
            (ident(id), bytes)
        })
        .collect()
}

fn hex_arg(s: &str, what: &str) -> Vec<u8> {
    hex::decode(s.trim()).unwrap_or_else(|e| die(&format!("bad {what} hex: {e}")))
}

fn out(value: serde_json::Value) {
    println!("{}", serde_json::to_string(&value).unwrap());
}

fn main() {
    let cli = Cli::parse();
    match cli.command {
        Command::DkgPart1 { id, max_signers, min_signers, secret_out } => {
            if min_signers < 2 || min_signers > max_signers {
                die("need 2 <= min_signers <= max_signers");
            }
            let (secret, package) =
                frost_core::keys::dkg::part1::<E, _>(ident(id), max_signers, min_signers, OsRng)
                    .unwrap_or_else(|e| die(&format!("dkg part1: {e}")));
            write_secret(&secret_out, &secret.serialize().unwrap_or_else(|e| die(&format!("{e}"))));
            out(json!({
                "round1_package": hex::encode(package.serialize().unwrap_or_else(|e| die(&format!("{e}")))),
            }));
        }
        Command::DkgPart2 { secret_in, round1, secret_out } => {
            let secret = DkgR1Secret::deserialize(&read_hex_file(&secret_in))
                .unwrap_or_else(|e| die(&format!("bad round1 secret: {e}")));
            let packages: BTreeMap<Identifier, DkgR1Package> = read_hex_map(&round1)
                .into_iter()
                .map(|(id, b)| {
                    (id, DkgR1Package::deserialize(&b).unwrap_or_else(|e| die(&format!("bad round1 package: {e}"))))
                })
                .collect();
            let (secret2, outgoing) = frost_core::keys::dkg::part2(secret, &packages)
                .unwrap_or_else(|e| die(&format!("dkg part2: {e}")));
            write_secret(&secret_out, &secret2.serialize().unwrap_or_else(|e| die(&format!("{e}"))));
            let map: BTreeMap<String, String> = outgoing
                .into_iter()
                .map(|(id, p)| {
                    (
                        ident_to_u16(&id).to_string(),
                        hex::encode(p.serialize().unwrap_or_else(|e| die(&format!("{e}")))),
                    )
                })
                .collect();
            out(json!({ "round2_packages": map }));
            // Round-1 secret is consumed; remove it so it cannot be replayed.
            let _ = fs::remove_file(&secret_in);
        }
        Command::DkgPart3 { secret_in, round1, round2, key_package_out } => {
            let secret = DkgR2Secret::deserialize(&read_hex_file(&secret_in))
                .unwrap_or_else(|e| die(&format!("bad round2 secret: {e}")));
            let r1: BTreeMap<Identifier, DkgR1Package> = read_hex_map(&round1)
                .into_iter()
                .map(|(id, b)| {
                    (id, DkgR1Package::deserialize(&b).unwrap_or_else(|e| die(&format!("bad round1 package: {e}"))))
                })
                .collect();
            let r2: BTreeMap<Identifier, DkgR2Package> = read_hex_map(&round2)
                .into_iter()
                .map(|(id, b)| {
                    (id, DkgR2Package::deserialize(&b).unwrap_or_else(|e| die(&format!("bad round2 package: {e}"))))
                })
                .collect();
            let (key_package, public_key_package) = frost_core::keys::dkg::part3(&secret, &r1, &r2)
                .unwrap_or_else(|e| die(&format!("dkg part3: {e}")));
            write_secret(
                &key_package_out,
                &key_package.serialize().unwrap_or_else(|e| die(&format!("{e}"))),
            );
            let group_pubkey = public_key_package.verifying_key().serialize()
                .unwrap_or_else(|e| die(&format!("{e}")));
            out(json!({
                "public_key_package": hex::encode(public_key_package.serialize().unwrap_or_else(|e| die(&format!("{e}")))),
                "group_pubkey": hex::encode(group_pubkey),
            }));
            let _ = fs::remove_file(&secret_in);
        }
        Command::Commit { key_package, nonces_out } => {
            let kp = KeyPackage::deserialize(&read_hex_file(&key_package))
                .unwrap_or_else(|e| die(&format!("bad key package: {e}")));
            let (nonces, commitments) = frost_core::round1::commit(kp.signing_share(), &mut OsRng);
            write_secret(&nonces_out, &nonces.serialize().unwrap_or_else(|e| die(&format!("{e}"))));
            out(json!({
                "commitments": hex::encode(commitments.serialize().unwrap_or_else(|e| die(&format!("{e}")))),
            }));
        }
        Command::SigningPackage { msg, commitments } => {
            let msg = hex_arg(&msg, "msg");
            let map: BTreeMap<Identifier, SigningCommitments> = read_hex_map(&commitments)
                .into_iter()
                .map(|(id, b)| {
                    (id, SigningCommitments::deserialize(&b).unwrap_or_else(|e| die(&format!("bad commitments: {e}"))))
                })
                .collect();
            let sp = SigningPackage::new(map, &msg);
            out(json!({
                "signing_package": hex::encode(sp.serialize().unwrap_or_else(|e| die(&format!("{e}")))),
            }));
        }
        Command::Sign { key_package, nonces, signing_package } => {
            let kp = KeyPackage::deserialize(&read_hex_file(&key_package))
                .unwrap_or_else(|e| die(&format!("bad key package: {e}")));
            let n = SigningNonces::deserialize(&read_hex_file(&nonces))
                .unwrap_or_else(|e| die(&format!("bad nonces: {e}")));
            let sp = SigningPackage::deserialize(&hex_arg(&signing_package, "signing package"))
                .unwrap_or_else(|e| die(&format!("bad signing package: {e}")));
            // Delete the nonces BEFORE emitting the share: a crash after
            // signing must never leave reusable nonces on disk.
            fs::remove_file(&nonces).unwrap_or_else(|e| die(&format!("cannot delete nonces file: {e}")));
            let share = frost_core::round2::sign(&sp, &n, &kp)
                .unwrap_or_else(|e| die(&format!("sign: {e}")));
            out(json!({
                "signature_share": hex::encode(share.serialize()),
            }));
        }
        Command::Aggregate { public_key_package, signing_package, shares } => {
            let pkp = PublicKeyPackage::deserialize(&read_hex_file(&public_key_package))
                .unwrap_or_else(|e| die(&format!("bad public key package: {e}")));
            let sp = SigningPackage::deserialize(&hex_arg(&signing_package, "signing package"))
                .unwrap_or_else(|e| die(&format!("bad signing package: {e}")));
            let shares: BTreeMap<Identifier, SignatureShare> = read_hex_map(&shares)
                .into_iter()
                .map(|(id, b)| {
                    (id, SignatureShare::deserialize(&b).unwrap_or_else(|e| die(&format!("bad signature share: {e}"))))
                })
                .collect();
            // aggregate() verifies each share and the final signature against
            // the group key, identifying any misbehaving participant.
            let sig = frost_core::aggregate(&sp, &shares, &pkp)
                .unwrap_or_else(|e| die(&format!("aggregate: {e}")));
            let sig_bytes = sig.serialize().unwrap_or_else(|e| die(&format!("{e}")));
            // Independent check with the non-frost verifier before release.
            let pubkey = pkp.verifying_key().serialize().unwrap_or_else(|e| die(&format!("{e}")));
            let pk32: [u8; 32] = pubkey.clone().try_into().unwrap_or_else(|_| die("bad group pubkey length"));
            let sig64: [u8; 64] = sig_bytes.clone().try_into().unwrap_or_else(|_| die("bad signature length"));
            if !nano_verify::verify(&pk32, sp.message(), &sig64) {
                die("aggregated signature failed independent ed25519-blake2b verification");
            }
            out(json!({ "signature": hex::encode(sig_bytes) }));
        }
        Command::Verify { pubkey, msg, signature } => {
            let pk: [u8; 32] = hex_arg(&pubkey, "pubkey").try_into().unwrap_or_else(|_| die("pubkey must be 32 bytes"));
            let sig: [u8; 64] = hex_arg(&signature, "signature").try_into().unwrap_or_else(|_| die("signature must be 64 bytes"));
            let msg = hex_arg(&msg, "msg");
            let ok = nano_verify::verify(&pk, &msg, &sig);
            out(json!({ "valid": ok }));
            if !ok {
                std::process::exit(2);
            }
        }
        Command::InspectSigningPackage { signing_package } => {
            let sp = SigningPackage::deserialize(&hex_arg(&signing_package, "signing package"))
                .unwrap_or_else(|e| die(&format!("bad signing package: {e}")));
            let ids: Vec<String> = sp
                .signing_commitments()
                .keys()
                .map(|id| ident_to_u16(id).to_string())
                .collect();
            out(json!({
                "msg": hex::encode(sp.message()),
                "signer_ids": ids,
            }));
        }
        Command::GroupPubkey { public_key_package } => {
            let pkp = PublicKeyPackage::deserialize(&read_hex_file(&public_key_package))
                .unwrap_or_else(|e| die(&format!("bad public key package: {e}")));
            out(json!({
                "group_pubkey": hex::encode(pkp.verifying_key().serialize().unwrap_or_else(|e| die(&format!("{e}")))),
            }));
        }
    }
}
