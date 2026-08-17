import { blake2b } from "blakejs";

const WORK_SIZE = 8;
const HASH_SIZE = 32;
const MAX_WORK_ITERATIONS = 0xffffffff;

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new Error("Invalid hex length");
  return new Uint8Array(clean.match(/.{1,2}/g)!.map((b) => parseInt(b, 16)));
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function readUint64LE(bytes: Uint8Array, offset = 0): bigint {
  return (
    BigInt(bytes[offset]) |
    (BigInt(bytes[offset + 1]) << 8n) |
    (BigInt(bytes[offset + 2]) << 16n) |
    (BigInt(bytes[offset + 3]) << 24n) |
    (BigInt(bytes[offset + 4]) << 32n) |
    (BigInt(bytes[offset + 5]) << 40n) |
    (BigInt(bytes[offset + 6]) << 48n) |
    (BigInt(bytes[offset + 7]) << 56n)
  );
}

function writeUint64LE(value: bigint, bytes: Uint8Array, offset = 0): void {
  bytes[offset] = Number(value & 0xffn);
  bytes[offset + 1] = Number((value >> 8n) & 0xffn);
  bytes[offset + 2] = Number((value >> 16n) & 0xffn);
  bytes[offset + 3] = Number((value >> 24n) & 0xffn);
  bytes[offset + 4] = Number((value >> 32n) & 0xffn);
  bytes[offset + 5] = Number((value >> 40n) & 0xffn);
  bytes[offset + 6] = Number((value >> 48n) & 0xffn);
  bytes[offset + 7] = Number((value >> 56n) & 0xffn);
}

/**
 * Validate Nano proof-of-work.
 *
 * Work values are transmitted as big-endian hex strings. The Nano protocol
 * validates by serializing the work value as little-endian bytes, hashing
 * `work_le_bytes || root_bytes` with BLAKE2b-8, and interpreting the digest as
 * a little-endian integer that must be greater than or equal to the threshold.
 */
export function validateWork(work: string, root: string, threshold: string): boolean {
  if (!/^[0-9a-fA-F]{16}$/.test(work)) return false;
  if (!/^[0-9a-fA-F]{64}$/.test(root)) return false;
  if (!/^[0-9a-fA-F]{16}$/.test(threshold)) return false;

  const workBytes = hexToBytes(work);
  const rootBytes = hexToBytes(root);
  const input = new Uint8Array(WORK_SIZE + HASH_SIZE);
  // Reverse work bytes: work hex is big-endian, validation uses little-endian.
  for (let i = 0; i < WORK_SIZE; i++) {
    input[i] = workBytes[WORK_SIZE - 1 - i];
  }
  input.set(rootBytes, WORK_SIZE);

  const result = blake2b(input, undefined, WORK_SIZE) as Uint8Array;
  const difficulty = readUint64LE(result);
  const thresholdValue = BigInt("0x" + threshold.toLowerCase());

  return difficulty >= thresholdValue;
}

/**
 * Generate Nano proof-of-work for a root hash and difficulty threshold.
 *
 * Returns a promise that resolves to a 16-character hex string representing the
 * 8-byte work value in little-endian byte order.
 */
export function generateWork(root: string, threshold: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!/^[0-9a-fA-F]{64}$/.test(root)) {
      reject(new Error("Invalid root hash"));
      return;
    }
    if (!/^[0-9a-fA-F]{16}$/.test(threshold)) {
      reject(new Error("Invalid threshold"));
      return;
    }

    const rootBytes = hexToBytes(root);
    const thresholdValue = BigInt("0x" + threshold.toLowerCase());
    const input = new Uint8Array(WORK_SIZE + HASH_SIZE);
    input.set(rootBytes, WORK_SIZE);

    // Random starting point to avoid deterministic collisions.
    let randomBytes: Uint8Array;
    if (typeof crypto !== "undefined" && crypto.getRandomValues) {
      randomBytes = crypto.getRandomValues(new Uint8Array(WORK_SIZE));
    } else {
      // Node.js fallback.
      const nodeCrypto = require("crypto");
      randomBytes = new Uint8Array(nodeCrypto.randomBytes(WORK_SIZE));
    }
    let workValue = readUint64LE(randomBytes);
    const workBytesLE = new Uint8Array(WORK_SIZE);

    const startTime = Date.now();

    function searchBatch(): void {
      // Synchronous batch: 2M iterations before checking time. This keeps
      // server-side generation fast while still bounding the runtime.
      for (let i = 0; i < 2000000; i++) {
        writeUint64LE(workValue, workBytesLE);
        input.set(workBytesLE, 0);
        const result = blake2b(input, undefined, WORK_SIZE) as Uint8Array;
        const difficulty = readUint64LE(result);

        if (difficulty >= thresholdValue) {
          // Return the work value as a big-endian hex string (standard Nano format).
          const beBytes = new Uint8Array(WORK_SIZE);
          for (let j = 0; j < WORK_SIZE; j++) {
            beBytes[j] = workBytesLE[WORK_SIZE - 1 - j];
          }
          resolve(bytesToHex(beBytes).toLowerCase());
          return;
        }

        workValue = (workValue + 1n) & 0xffffffffffffffffn;
      }

      if (Date.now() - startTime > 55000) {
        reject(new Error("Work generation timed out"));
        return;
      }

      // Yield to the event loop to keep the function non-blocking in browsers.
      setTimeout(searchBatch, 0);
    }

    searchBatch();
  });
}
