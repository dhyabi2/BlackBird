import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from "bip39";
import { blake2b } from "blakejs";
import { bytesToHex } from "./vela-crypto";

export function createBackupPhrase(): string {
  return generateMnemonic();
}

export function phraseToSeedHex(phrase: string): string {
  const normalized = phrase.trim().toLowerCase().split(/\s+/).join(" ");
  if (!validateMnemonic(normalized)) {
    throw new Error("Invalid recovery phrase");
  }
  const seed = mnemonicToSeedSync(normalized); // 64 bytes
  const hash = blake2b(seed, undefined, 32) as Uint8Array;
  return bytesToHex(hash);
}
