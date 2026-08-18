//! Differential test: FROST(Ed25519, Blake2b-512) joint and adaptor-completed
//! signatures are piped as vectors into an independent pure-Python
//! ed25519-blake2b verifier (`tests/nano_ref.py`), the second half of the I2
//! hardening battery ("second-language cross-implementation").

use std::collections::BTreeMap;
use std::io::Write;
use std::process::{Command, Stdio};

use curve25519_dalek::{edwards::EdwardsPoint, scalar::Scalar};
use rand::rngs::OsRng;
use rand::RngCore;

use signing::adaptor::{adaptor_sign, aggregate_presignature, complete_presignature, AdaptorSession};
use signing::{keys, round1, round2, Identifier};

struct Vector {
    pubkey: [u8; 32],
    msg: Vec<u8>,
    sig: [u8; 64],
    expect: bool,
}

fn setup() -> (Vec<(Identifier, keys::KeyPackage)>, keys::PublicKeyPackage) {
    let (shares, pubkeys) =
        keys::generate_with_dealer(2, 2, keys::IdentifierList::Default, &mut OsRng).unwrap();
    let parties = shares
        .into_iter()
        .map(|(id, s)| (id, keys::KeyPackage::try_from(s).unwrap()))
        .collect();
    (parties, pubkeys)
}

fn joint_sign(msg: &[u8]) -> Vector {
    let (parties, pubkeys) = setup();
    let mut nonces = BTreeMap::new();
    let mut comms = BTreeMap::new();
    for (id, kp) in &parties {
        let (n, c) = round1::commit(kp.signing_share(), &mut OsRng);
        nonces.insert(*id, n);
        comms.insert(*id, c);
    }
    let package = signing::SigningPackage::new(comms, msg);
    let mut shares = BTreeMap::new();
    for (id, kp) in &parties {
        shares.insert(*id, round2::sign(&package, &nonces[id], kp).unwrap());
    }
    let sig = signing::aggregate(&package, &shares, &pubkeys).unwrap();
    Vector {
        pubkey: pubkeys
            .verifying_key()
            .serialize()
            .unwrap()
            .try_into()
            .unwrap(),
        msg: msg.to_vec(),
        sig: sig.serialize().unwrap().try_into().unwrap(),
        expect: true,
    }
}

fn adaptor_completed_sign(msg: &[u8], x: Scalar) -> Vector {
    let (parties, pubkeys) = setup();
    let mut nonces = BTreeMap::new();
    let mut comms = BTreeMap::new();
    for (id, kp) in &parties {
        let (n, c) = round1::commit(kp.signing_share(), &mut OsRng);
        nonces.insert(*id, n);
        comms.insert(*id, c);
    }
    let t = EdwardsPoint::mul_base(&x).compress().to_bytes();
    let session = AdaptorSession::new(comms, msg, &t).unwrap();
    let mut shares = BTreeMap::new();
    for (id, kp) in &parties {
        shares.insert(*id, adaptor_sign(&session, &nonces[id], kp).unwrap());
    }
    let presig = aggregate_presignature(&session, &shares, &pubkeys).unwrap();
    let sig = complete_presignature(&presig, &x.to_bytes()).unwrap();
    Vector {
        pubkey: pubkeys
            .verifying_key()
            .serialize()
            .unwrap()
            .try_into()
            .unwrap(),
        msg: msg.to_vec(),
        sig,
        expect: true,
    }
}

#[test]
fn python_reference_agrees_on_all_vectors() {
    let mut vectors = Vec::new();

    // Joint signatures over varied messages (empty, short, 32-byte hash-like, long).
    vectors.push(joint_sign(b""));
    vectors.push(joint_sign(b"x"));
    vectors.push(joint_sign(&[0xAB; 32]));
    vectors.push(joint_sign(&vec![0x5C; 1024]));
    for _ in 0..4 {
        let mut m = [0u8; 32];
        OsRng.fill_bytes(&mut m);
        vectors.push(joint_sign(&m));
    }

    // Adaptor-completed signatures, including edge secrets.
    vectors.push(adaptor_completed_sign(b"adaptor msg", Scalar::ONE));
    vectors.push(adaptor_completed_sign(b"adaptor msg", -Scalar::ONE));
    vectors.push(adaptor_completed_sign(
        &[0x11; 32],
        Scalar::from_bytes_mod_order_wide(&[42u8; 64]),
    ));

    // Negative vectors: tampered signature, tampered message, wrong pubkey.
    let good = joint_sign(b"negative base");
    let mut bad_sig = Vector {
        pubkey: good.pubkey,
        msg: good.msg.clone(),
        sig: good.sig,
        expect: false,
    };
    bad_sig.sig[40] ^= 0x01;
    vectors.push(bad_sig);
    vectors.push(Vector {
        pubkey: good.pubkey,
        msg: b"tampered message".to_vec(),
        sig: good.sig,
        expect: false,
    });
    let other = joint_sign(b"negative base");
    vectors.push(Vector {
        pubkey: other.pubkey,
        msg: good.msg.clone(),
        sig: good.sig,
        expect: false,
    });
    vectors.push(good);

    // Every vector's expectation must already hold under the in-crate verifier…
    for (i, v) in vectors.iter().enumerate() {
        assert_eq!(
            signing::nano_verify::verify(&v.pubkey, &v.msg, &v.sig),
            v.expect,
            "in-crate verifier disagrees on vector {i}"
        );
    }

    // …and under the pure-Python reference.
    let script = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/nano_ref.py");
    let mut child = Command::new("python3")
        .arg(script)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .expect("spawn python3");
    {
        let stdin = child.stdin.as_mut().unwrap();
        for v in &vectors {
            writeln!(
                stdin,
                r#"{{"pub":"{}","msg":"{}","sig":"{}","expect":{}}}"#,
                hex::encode(v.pubkey),
                hex::encode(&v.msg),
                hex::encode(v.sig),
                v.expect
            )
            .unwrap();
        }
    }
    let out = child.wait_with_output().expect("python3 runs");
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(
        out.status.success(),
        "python reference disagreed: {stdout}"
    );
    assert!(stdout.contains(&format!("OK {}", vectors.len())), "{stdout}");
}
