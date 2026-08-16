import * as nano from "nanocurrency";
import { blake2bHex } from "blakejs";

const BASE_URL = process.env.VELA_BASE_URL || "https://velav2-web.vercel.app";
const ZERO_HASH = "0".repeat(64);
const RECEIVE_THRESHOLD = "fffffe0000000000";
const DEFAULT_DENOM = "1000000000000000000000000000000"; // 1 XNO

function getSeed() {
  if (process.env.GUARDIAN_SEED) return process.env.GUARDIAN_SEED;
  if (process.env.GUARDIAN_SEED_FILE) {
    return (await import("fs")).readFileSync(process.env.GUARDIAN_SEED_FILE, "utf8").trim();
  }
  throw new Error("Set GUARDIAN_SEED or GUARDIAN_SEED_FILE");
}

function derivePoolKey(seedHex, denomRaw) {
  // Match Python: hashlib.blake2b(seed + str(denom).encode()).digest()
  const seedBytes = Buffer.from(seedHex, "hex");
  const denomBytes = Buffer.from(String(denomRaw), "utf8");
  const input = Buffer.concat([seedBytes, denomBytes]);
  const secretKey = blake2bHex(input, undefined, 32);
  const publicKey = nano.derivePublicKey(secretKey);
  const address = nano.deriveAddress(publicKey, { useNanoPrefix: true });
  return { secretKey, publicKey, address };
}

async function apiPost(path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `POST ${path} failed: ${res.status}`);
  return data;
}

async function apiGet(path) {
  const res = await fetch(`${BASE_URL}${path}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `GET ${path} failed: ${res.status}`);
  return data;
}

async function computeWork(hash, threshold) {
  return nano.computeWork(hash, { workThreshold: threshold });
}

function buildBlock(sk, { previous, representative, balance, link, work }) {
  const block = nano.createBlock(sk, { work, previous, representative, balance, link });
  const cleaned = { ...block.block };
  delete cleaned.link_as_account;
  cleaned.account = address;
  cleaned.representative = representative;
  return { hash: block.hash, block: cleaned };
}

const seed = await getSeed();
const denom = process.argv[2] || DEFAULT_DENOM;
const { secretKey, publicKey, address } = derivePoolKey(seed, denom);

console.log(`Funding pool address for ${denom} raw: ${address}`);

const infoRes = await apiGet(`/api/account_info?account=${encodeURIComponent(address)}`);
const opened = Boolean(infoRes.frontier && infoRes.frontier !== ZERO_HASH);
const representative = infoRes.representative || address;
let previous = opened ? infoRes.frontier : ZERO_HASH;
let balance = BigInt(infoRes.balance || "0");

const pendingRes = await apiGet(`/api/pending?account=${encodeURIComponent(address)}`).catch(() => ({ blocks: {} }));
const pendingBlocks = pendingRes.blocks || {};
const entries = Object.entries(pendingBlocks);

if (entries.length === 0) {
  console.log("No pending sends to receive.");
  process.exit(0);
}

for (const [hash, block] of entries) {
  const amount = BigInt(block.amount || "0");
  const workHash = previous === ZERO_HASH ? publicKey : previous;
  const work = await computeWork(workHash, RECEIVE_THRESHOLD);
  const newBalance = (balance + amount).toString();
  const receiveBlock = buildBlock(secretKey, {
    previous,
    representative,
    balance: newBalance,
    link: hash,
    work,
  });
  console.log(`Receive ${hash.slice(0, 16)}... -> ${receiveBlock.hash}`);
  await apiPost("/api/broadcast", { block: receiveBlock.block });
  previous = receiveBlock.hash;
  balance = BigInt(newBalance);
}

console.log(`Pool ${address} balance: ${balance.toString()} raw`);
