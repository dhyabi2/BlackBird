import { hexToBytes, bytesToHex } from "./vela-crypto";

const PBKDF2_ITERATIONS = 200_000;

async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const material = await crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: salt as unknown as BufferSource,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

export async function encryptSeed(seedHex: string, password: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveKey(password, salt);
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as unknown as BufferSource },
    key,
    hexToBytes(seedHex) as unknown as BufferSource
  );
  const bytes = new Uint8Array(salt.length + iv.length + encrypted.byteLength);
  bytes.set(salt, 0);
  bytes.set(iv, salt.length);
  bytes.set(new Uint8Array(encrypted), salt.length + iv.length);
  return btoa(String.fromCharCode(...bytes));
}

export async function decryptSeed(ciphertext: string, password: string): Promise<string> {
  const bytes = Uint8Array.from(atob(ciphertext), (c) => c.charCodeAt(0));
  if (bytes.length < 28) {
    throw new Error("Invalid wallet data");
  }
  const salt = bytes.slice(0, 16);
  const iv = bytes.slice(16, 28);
  const encrypted = bytes.slice(28);
  const key = await deriveKey(password, salt);
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: iv as unknown as BufferSource },
    key,
    encrypted as unknown as BufferSource
  );
  return bytesToHex(new Uint8Array(decrypted));
}
