import {
  poseidon2,
  poseidon3,
  poseidon9,
} from "poseidon-lite";

export const DOMAIN_DEPOSIT = BigInt(1);
export const DOMAIN_NULL = BigInt(2);

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new Error("Invalid hex length");
  return new Uint8Array(
    clean.match(/.{1,2}/g)!.map((b) => parseInt(b, 16))
  );
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function split32(value: Uint8Array): [bigint, bigint] {
  if (value.length !== 32) throw new Error("Expected 32 bytes");
  const hi = BigInt("0x" + bytesToHex(value.slice(0, 16)));
  const lo = BigInt("0x" + bytesToHex(value.slice(16, 32)));
  return [lo, hi];
}

export function computeCommitment(
  n: Uint8Array,
  t: Uint8Array,
  P_w: Uint8Array,
  S_pub: Uint8Array
): bigint {
  const [n_lo, n_hi] = split32(n);
  const [t_lo, t_hi] = split32(t);
  const [P_w_lo, P_w_hi] = split32(P_w);
  const [S_pub_lo, S_pub_hi] = split32(S_pub);
  return poseidon9([
    DOMAIN_DEPOSIT,
    n_lo,
    n_hi,
    t_lo,
    t_hi,
    P_w_lo,
    P_w_hi,
    S_pub_lo,
    S_pub_hi,
  ]);
}

export function computeNullifier(n: Uint8Array): bigint {
  const [n_lo, n_hi] = split32(n);
  return poseidon3([DOMAIN_NULL, n_lo, n_hi]);
}

export function computeLeafHash(commitment: bigint): bigint {
  return poseidon2([commitment, BigInt(0)]);
}
