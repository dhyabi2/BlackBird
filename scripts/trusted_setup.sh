#!/bin/bash
set -e

# Groth16 trusted setup for VELA v2 withdrawal circuit.
# WARNING: This uses a fresh local ceremony for prototyping only.
# Production deployments require a secure multi-party ceremony.

cd "$(dirname "$0")/../circuit/build"

POWER=14
PTAU_0="pot${POWER}_0000.ptau"
PTAU_1="pot${POWER}_0001.ptau"
PTAU_FINAL="pot${POWER}_final.ptau"
ZKEY_0="vela_0000.zkey"
ZKEY_FINAL="vela_final.zkey"
VK="verification_key.json"

echo "=== Generating powers-of-tau (2^$POWER) ==="
node ../../node_modules/.bin/snarkjs powersoftau new bn128 "$POWER" "$PTAU_0" -v

echo "=== Contributing to powers-of-tau ==="
ENTROPY=$(openssl rand -hex 32)
echo "$ENTROPY" | node ../../node_modules/.bin/snarkjs powersoftau contribute "$PTAU_0" "$PTAU_1" --name="VELA-local-1" -v

echo "=== Preparing phase 2 ==="
node ../../node_modules/.bin/snarkjs powersoftau prepare phase2 "$PTAU_1" "$PTAU_FINAL" -v

echo "=== Groth16 setup ==="
node ../../node_modules/.bin/snarkjs groth16 setup ./vela.r1cs "$PTAU_FINAL" "$ZKEY_0"

echo "=== Contributing to zkey ==="
ENTROPY2=$(openssl rand -hex 32)
echo "$ENTROPY2" | node ../../node_modules/.bin/snarkjs zkey contribute "$ZKEY_0" "$ZKEY_FINAL" --name="VELA-local-2" -v

echo "=== Exporting verification key ==="
node ../../node_modules/.bin/snarkjs zkey export verificationkey "$ZKEY_FINAL" "$VK"

echo "=== Trusted setup complete ==="
ls -lh "$ZKEY_FINAL" "$VK"
