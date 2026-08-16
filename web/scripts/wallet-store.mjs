import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PLAIN_FILE = path.join(ROOT, "test-wallets.json");
const ENC_FILE = path.join(ROOT, "test-wallets.json.enc");

function loadEnvLocal() {
  const envPath = path.join(ROOT, ".env.local");
  if (!fs.existsSync(envPath)) return;
  const text = fs.readFileSync(envPath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx);
    const value = trimmed.slice(idx + 1).trim();
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

function getPassword() {
  loadEnvLocal();
  const pass = process.env.VELA_TEST_WALLET_PASSWORD;
  if (!pass) {
    throw new Error("VELA_TEST_WALLET_PASSWORD is not set");
  }
  return pass;
}

function deriveKey(password, salt) {
  return crypto.scryptSync(password, salt, 32);
}

export function encryptWallets(wallets, password) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(16);
  const key = deriveKey(password, salt);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(wallets), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const payload = {
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: authTag.toString("base64"),
    data: ciphertext.toString("base64"),
  };
  return Buffer.from(JSON.stringify(payload), "utf8");
}

export function decryptWallets(password) {
  if (!fs.existsSync(ENC_FILE)) {
    throw new Error(`Encrypted wallet store not found: ${ENC_FILE}`);
  }
  const payload = JSON.parse(fs.readFileSync(ENC_FILE, "utf8"));
  const salt = Buffer.from(payload.salt, "base64");
  const iv = Buffer.from(payload.iv, "base64");
  const tag = Buffer.from(payload.tag, "base64");
  const ciphertext = Buffer.from(payload.data, "base64");
  const key = deriveKey(password, salt);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plaintext.toString("utf8"));
}

export function loadTestWallets() {
  const password = getPassword();
  return decryptWallets(password);
}

export function hasEncryptedStore() {
  return fs.existsSync(ENC_FILE);
}

export function hasPlainStore() {
  return fs.existsSync(PLAIN_FILE);
}

export function migratePlainToEncrypted() {
  const password = getPassword();
  if (!fs.existsSync(PLAIN_FILE)) {
    throw new Error(`Plaintext wallet store not found: ${PLAIN_FILE}`);
  }
  const wallets = JSON.parse(fs.readFileSync(PLAIN_FILE, "utf8"));
  fs.writeFileSync(ENC_FILE, encryptWallets(wallets, password));
  fs.unlinkSync(PLAIN_FILE);
}
