import nanoWeb from "nanocurrency-web";
const { block, tools } = nanoWeb;
import blakejs from "blakejs";
const { blake2bHex } = blakejs;

const BASE_URL = process.env.VELA_BASE_URL || "https://velav2-web.vercel.app";
const ZERO_HASH = "0".repeat(64);
const DEFAULT_DENOM = "1000000000000000000000000000000"; // 1 XNO

async function getSeed() {
  if (process.env.GUARDIAN_SEED) return process.env.GUARDIAN_SEED;
  if (process.env.GUARDIAN_SEED_FILE) {
    const fs = await import("fs");
    return fs.readFileSync(process.env.GUARDIAN_SEED_FILE, "utf8").trim();
  }
  throw new Error("Set GUARDIAN_SEED or GUARDIAN_SEED_FILE");
}

function derivePoolSecretKey(seedHex, denomRaw) {
  // Match Python: hashlib.blake2b(seed + str(denom).encode()).digest()
  const seedBytes = Buffer.from(seedHex, "hex");
  const denomBytes = Buffer.from(String(denomRaw), "utf8");
  const input = Buffer.concat([seedBytes, denomBytes]);
  return blake2bHex(input, undefined, 32).toUpperCase();
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

async function generateWork(hash, subtype = "receive") {
  const difficulty = subtype === "send" ? "fffffff800000000" : "fffffe0000000000";
  const res = await apiPost("/api/work", { hash, difficulty });
  if (!res.work) throw new Error("Work generator did not return work");
  return res.work;
}

function linkToAddress(link) {
  if (link.startsWith("nano_") || link.startsWith("xrb_")) {
    return link.startsWith("xrb_") ? "nano_" + link.slice(4) : link;
  }
  const clean = link.replace(/^0x/, "").toUpperCase();
  return tools.publicKeyToAddress(clean);
}

const seed = await getSeed();
const denom = process.argv[2] || DEFAULT_DENOM;
const secretKey = derivePoolSecretKey(seed, denom);

const poolData = await apiGet(`/api/pool_address/${denom}`);
const poolAddress = tools.publicKeyToAddress(poolData.pool_pubkey.toUpperCase());

console.log(`Funding pool address for ${denom} raw: ${poolAddress}`);

const infoRes = await apiGet(`/api/account_info?account=${encodeURIComponent(poolAddress)}`);
const opened = Boolean(infoRes.frontier && infoRes.frontier !== ZERO_HASH);
const representative = infoRes.representative || poolAddress;
let previous = opened ? infoRes.frontier : ZERO_HASH;
let balance = BigInt(infoRes.balance || "0");

const pendingRes = await apiGet(`/api/pending?account=${encodeURIComponent(poolAddress)}`).catch(() => ({ blocks: {} }));
const pendingBlocks = pendingRes.blocks || {};
const entries = Object.entries(pendingBlocks);

if (entries.length === 0) {
  console.log("No pending sends to receive.");
  process.exit(0);
}

for (const [hash, pendingBlock] of entries) {
  const amount = BigInt(pendingBlock.amount || "0");
  const workHash = previous === ZERO_HASH ? tools.addressToPublicKey(poolAddress) : previous;
  const work = await generateWork(workHash, "receive");
  const signed = block.receive(
    {
      walletBalanceRaw: previous === ZERO_HASH ? "0" : balance.toString(),
      toAddress: poolAddress,
      representativeAddress: representative,
      frontier: previous,
      transactionHash: hash,
      amountRaw: amount.toString(),
      work,
    },
    secretKey.toLowerCase()
  );
  const receiveBlock = { ...signed, subtype: "receive" };
  console.log(`Receive ${hash.slice(0, 16)}... -> ${tools.addressToPublicKey(signed.account)}`);
  if (signed.account !== poolAddress) {
    throw new Error("Derived pool account does not match expected pool address");
  }
  await apiPost("/api/broadcast", { block: receiveBlock, subtype: "receive" });
  previous = hashBlock(signed);
  balance += amount;
}

console.log(`Pool ${poolAddress} balance: ${balance.toString()} raw`);

function hashBlock(signed) {
  const prefix = new Uint8Array(32);
  prefix[31] = 6;
  const account = hexToBytes(tools.addressToPublicKey(String(signed.account)));
  const previous = hexToBytes(String(signed.previous));
  const representative = hexToBytes(tools.addressToPublicKey(String(signed.representative)));
  const balanceBytes = rawTo16Bytes(String(signed.balance));
  const link = hexToBytes(String(signed.link));
  const payload = new Uint8Array(32 + account.length + previous.length + representative.length + balanceBytes.length + link.length);
  let offset = 0;
  payload.set(prefix, offset);
  offset += 32;
  payload.set(account, offset);
  offset += account.length;
  payload.set(previous, offset);
  offset += previous.length;
  payload.set(representative, offset);
  offset += representative.length;
  payload.set(balanceBytes, offset);
  offset += balanceBytes.length;
  payload.set(link, offset);
  return blake2bHex(payload, undefined, 32).toUpperCase();
}

function hexToBytes(hex) {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  return new Uint8Array(clean.match(/.{1,2}/g).map((b) => parseInt(b, 16)));
}

function rawTo16Bytes(raw) {
  let value = BigInt(raw);
  const bytes = new Uint8Array(16);
  for (let i = 15; i >= 0; i--) {
    bytes[i] = Number(value & 0xffn);
    value >>= 8n;
  }
  return bytes;
}
