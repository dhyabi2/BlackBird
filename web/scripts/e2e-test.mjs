import * as fs from "fs";
import * as path from "path";
import * as nano from "nanocurrency";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const WALLETS_FILE = path.join(ROOT, "test-wallets.json");
const BASE_URL = process.env.VELA_BASE_URL || "https://velav2-web.vercel.app";
const ZERO_HASH = "0".repeat(64);

function ensureNanoPrefix(address) {
  if (address.startsWith("xrb_")) return "nano_" + address.slice(4);
  return address;
}

function generateWallet(seed, index) {
  const secretKey = nano.deriveSecretKey(seed, index);
  const publicKey = nano.derivePublicKey(secretKey);
  const address = nano.deriveAddress(publicKey, { useNanoPrefix: true });
  return { seed, index, secretKey, publicKey, address };
}

function buildBlock(secretKey, { previous, representative, balance, link, work }) {
  const block = nano.createBlock(secretKey, {
    work,
    previous,
    representative,
    balance,
    link,
  });
  const cleaned = { ...block.block };
  delete cleaned.link_as_account;
  cleaned.account = ensureNanoPrefix(String(cleaned.account));
  cleaned.representative = ensureNanoPrefix(String(cleaned.representative));
  return { hash: block.hash, block: cleaned };
}

async function apiGet(path) {
  const res = await fetch(`${BASE_URL}${path}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `GET ${path} failed: ${res.status}`);
  return data;
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

const SEND_THRESHOLD = "fffffff800000000";
const RECEIVE_THRESHOLD = "fffffe0000000000";

function workHashForReceive(previous, publicKey) {
  // For the first (open) receive block, work is generated on the account public key.
  return previous === ZERO_HASH ? publicKey : previous;
}

async function computeWork(hash, threshold) {
  return nano.computeWork(hash, { workThreshold: threshold });
}

async function fetchAccountInfo(account) {
  return apiGet(`/api/account_info?account=${encodeURIComponent(account)}`);
}

async function fetchPending(account) {
  return apiGet(`/api/pending?account=${encodeURIComponent(account)}`);
}

async function broadcastBlock(block) {
  return apiPost("/api/broadcast", { block });
}

async function fetchAccountHistoryDirect(account) {
  const res = await fetch("https://node.somenano.com/proxy", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "account_history", account, count: 100 }),
  });
  const data = await res.json();
  if (data.error) throw new Error(`account_history error: ${JSON.stringify(data.error)}`);
  return data.history || [];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadWallets() {
  if (!fs.existsSync(WALLETS_FILE)) {
    throw new Error(`No wallets file. Run: node scripts/e2e-test.mjs init`);
  }
  return JSON.parse(fs.readFileSync(WALLETS_FILE, "utf8"));
}

function saveWallets(wallets) {
  fs.writeFileSync(WALLETS_FILE, JSON.stringify(wallets, null, 2));
}

async function cmdInit() {
  const fundingSeed = await nano.generateSeed();
  const funding = generateWallet(fundingSeed, 0);
  const receivers = [];
  for (let i = 0; i < 10; i++) {
    const seed = await nano.generateSeed();
    receivers.push(generateWallet(seed, 0));
  }
  const data = {
    funding,
    receivers,
  };
  saveWallets(data);
  console.log("Funding address (send 1 XNO here):");
  console.log(funding.address);
  console.log("\nReceiver addresses (10 x 0.1 XNO will be sent here):");
  receivers.forEach((r, i) => console.log(`${i + 1}. ${r.address}`));
  console.log(`\nSaved to ${WALLETS_FILE}`);
}

async function cmdReceiveFunding() {
  const { funding } = loadWallets();
  console.log(`Polling pending for ${funding.address} ...`);
  const deadline = Date.now() + 5 * 60 * 1000;
  let sendHash;
  let amountRaw;
  while (Date.now() < deadline) {
    const pending = await fetchPending(funding.address);
    const blocks = pending.blocks || {};
    const hashes = Object.keys(blocks);
    if (hashes.length > 0) {
      [sendHash, { amount: amountRaw }] = hashes
        .map((h) => [h, blocks[h]])
        .sort((a, b) => BigInt(b[1].amount) - BigInt(a[1].amount))[0];
      break;
    }
    console.log("  no pending yet, waiting 10s ...");
    await sleep(10_000);
  }
  if (!sendHash) {
    console.log("No pending blocks found within 5 minutes.");
    return;
  }
  console.log(`Found pending send ${sendHash} with amount ${amountRaw} raw`);

  const work = await computeWork(workHashForReceive(ZERO_HASH, funding.publicKey), RECEIVE_THRESHOLD);
  const receiveBlock = buildBlock(funding.secretKey, {
    previous: ZERO_HASH,
    representative: funding.address,
    balance: amountRaw,
    link: sendHash,
    work,
  });
  console.log(`Open/receive hash: ${receiveBlock.hash}`);
  await broadcastBlock(receiveBlock.block);
  console.log("Funding receive broadcasted.");
}

async function reconstructSendHashesFromHistory(data) {
  const { funding, receivers } = data;
  const history = await fetchAccountHistoryDirect(funding.address);
  const sends = history.filter((h) => h.type === "send");
  const newSendHashes = [];
  for (const receiver of receivers) {
    const found = sends.find((h) => h.account === receiver.address);
    if (found) {
      newSendHashes.push({ address: receiver.address, hash: found.hash });
    } else {
      break;
    }
  }
  data.sendHashes = newSendHashes;
  saveWallets(data);
  return newSendHashes.length;
}

async function cmdSplit() {
  const data = loadWallets();
  const { funding, receivers } = data;
  const info = await fetchAccountInfo(funding.address);
  if (!info.frontier) throw new Error("Funding account not opened");

  // Recover any sends already confirmed on-chain.
  await reconstructSendHashesFromHistory(data);
  const sendHashes = data.sendHashes || [];

  const amountRaw = nano.convert("0.1", { from: "NANO", to: "raw" });
  const startIndex = sendHashes.length;
  const remaining = receivers.length - startIndex;
  if (remaining === 0) {
    console.log("All sends already broadcasted.");
    return;
  }
  const requiredRaw = BigInt(amountRaw) * BigInt(remaining);
  const startBalance = BigInt(info.balance);
  if (startBalance < requiredRaw) {
    throw new Error(
      `Funding balance ${startBalance} raw is less than required ${requiredRaw} raw for ${remaining} remaining sends`
    );
  }

  let previous = info.frontier;
  let balance = startBalance;
  for (let i = startIndex; i < receivers.length; i++) {
    const receiver = receivers[i];
    balance -= BigInt(amountRaw);
    const sendBlock = buildBlock(funding.secretKey, {
      previous,
      representative: funding.address,
      balance: balance.toString(),
      link: receiver.address,
      work: await computeWork(previous, SEND_THRESHOLD),
    });
    console.log(`Send ${i + 1}/${receivers.length} to ${receiver.address}: ${sendBlock.hash}`);
    try {
      await broadcastBlock(sendBlock.block);
    } catch (err) {
      if (String(err.message).includes("Old block")) {
        // The block may already be confirmed; recover its hash from history.
        const history = await fetchAccountHistoryDirect(funding.address);
        const found = history.find((h) => h.type === "send" && h.account === receiver.address);
        if (!found) throw err;
        console.log(`  already on-chain, using ${found.hash}`);
        sendHashes.push({ address: receiver.address, hash: found.hash });
        data.sendHashes = sendHashes;
        saveWallets(data);
        previous = found.hash;
        continue;
      }
      throw err;
    }
    sendHashes.push({ address: receiver.address, hash: sendBlock.hash });
    data.sendHashes = sendHashes;
    saveWallets(data);
    previous = sendBlock.hash;
  }
  console.log("All 10 sends broadcasted.");
}

async function cmdReceiveSplit() {
  const { receivers, sendHashes = [] } = loadWallets();
  if (sendHashes.length !== receivers.length) {
    throw new Error("Run split first");
  }
  const amountRaw = nano.convert("0.1", { from: "NANO", to: "raw" });
  for (let i = 0; i < receivers.length; i++) {
    const receiver = receivers[i];
    const sendHash = sendHashes[i].hash;
    console.log(`Receiving ${i + 1}/${receivers.length} for ${receiver.address} ...`);
    const work = await computeWork(workHashForReceive(ZERO_HASH, receiver.publicKey), RECEIVE_THRESHOLD);
    const receiveBlock = buildBlock(receiver.secretKey, {
      previous: ZERO_HASH,
      representative: receiver.address,
      balance: amountRaw,
      link: sendHash,
      work,
    });
    console.log(`  receive hash: ${receiveBlock.hash}`);
    await broadcastBlock(receiveBlock.block);
  }
  console.log("All 10 receives broadcasted.");
}

async function cmdStatus() {
  const { funding, receivers } = loadWallets();
  console.log("Funding:");
  try {
    const info = await fetchAccountInfo(funding.address);
    console.log(`  ${funding.address}: ${nano.convert(info.balance, { from: "raw", to: "NANO" })} XNO`);
  } catch (e) {
    console.log(`  ${funding.address}: not opened / ${e.message}`);
  }
  console.log("Receivers:");
  for (const r of receivers) {
    try {
      const info = await fetchAccountInfo(r.address);
      console.log(`  ${r.address}: ${nano.convert(info.balance, { from: "raw", to: "NANO" })} XNO`);
    } catch (e) {
      console.log(`  ${r.address}: not opened / ${e.message}`);
    }
  }
}

async function main() {
  const cmd = process.argv[2];
  switch (cmd) {
    case "init":
      await cmdInit();
      break;
    case "receive-funding":
      await cmdReceiveFunding();
      break;
    case "split":
      await cmdSplit();
      break;
    case "receive-split":
      await cmdReceiveSplit();
      break;
    case "status":
      await cmdStatus();
      break;
    default:
      console.log("Usage: node scripts/e2e-test.mjs <init|receive-funding|split|receive-split|status>");
      process.exit(1);
  }
}

main().catch((err) => {
  console.error("ERROR:", err.message);
  process.exit(1);
});
