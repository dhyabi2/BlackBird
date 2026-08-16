import * as fs from "fs";
import * as path from "path";
import * as nano from "nanocurrency";
import { poseidon9, poseidon3 } from "poseidon-lite";
import { blake2b } from "blakejs";
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
  try {
    return await apiPost("/api/broadcast", { block });
  } catch (err) {
    // An "Old block" response means the exact block is already in the ledger,
    // which is equivalent to a successful broadcast.
    if (String(err.message).includes("Old block")) {
      return { old_block: true };
    }
    throw err;
  }
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

async function fetchAccountHistoryRaw(account) {
  const res = await fetch("https://node.somenano.com/proxy", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "account_history", account, count: 100, raw: true }),
  });
  const data = await res.json();
  if (data.error) throw new Error(`account_history error: ${JSON.stringify(data.error)}`);
  return data.history || [];
}

function isHex64(s) {
  return /^[0-9a-fA-F]{64}$/.test(s);
}

async function findDepositCommitHashes(sourceAddress, poolPubkeyHex) {
  const history = await fetchAccountHistoryRaw(sourceAddress);
  const poolLower = poolPubkeyHex.toLowerCase();
  for (let i = 0; i < history.length; i++) {
    const h = history[i];
    if (h.subtype !== "send") continue;
    const link = String(h.link || "").toLowerCase();
    if (link === poolLower) {
      // Commitment block is the next (newer) entry.
      if (i === 0) continue;
      const commit = history[i - 1];
      if (commit.subtype === "send" && isHex64(commit.link || "")) {
        return { depositHash: h.hash, commitHash: commit.hash };
      }
    }
  }
  return null;
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

// ---- VELA deposit / withdraw helpers ----

const DOMAIN_DEPOSIT = 1n;
const DOMAIN_NULL = 2n;

function hexToBytes(hex) {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new Error("Invalid hex length");
  return new Uint8Array(clean.match(/.{1,2}/g).map((b) => parseInt(b, 16)));
}

function bytesToHex(bytes) {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function split32(value) {
  if (value.length !== 32) throw new Error("Expected 32 bytes");
  const hi = BigInt("0x" + bytesToHex(value.slice(0, 16)));
  const lo = BigInt("0x" + bytesToHex(value.slice(16, 32)));
  return [lo, hi];
}

function computeCommitment(n, t, P_w, S_pub) {
  const [n_lo, n_hi] = split32(n);
  const [t_lo, t_hi] = split32(t);
  const [P_w_lo, P_w_hi] = split32(P_w);
  const [S_pub_lo, S_pub_hi] = split32(S_pub);
  return poseidon9([DOMAIN_DEPOSIT, n_lo, n_hi, t_lo, t_hi, P_w_lo, P_w_hi, S_pub_lo, S_pub_hi]);
}

function computeNullifier(n) {
  const [n_lo, n_hi] = split32(n);
  return poseidon3([DOMAIN_NULL, n_lo, n_hi]);
}

function deriveSecretBytes(seedHex, P_w_hex, salt) {
  const seedBytes = hexToBytes(seedHex);
  const PwBytes = hexToBytes(P_w_hex);
  const saltBytes = new TextEncoder().encode(salt);
  const input = new Uint8Array(seedBytes.length + PwBytes.length + saltBytes.length);
  input.set(seedBytes, 0);
  input.set(PwBytes, seedBytes.length);
  input.set(saltBytes, seedBytes.length + PwBytes.length);
  return blake2b(input, undefined, 32);
}

async function fetchPoolInfo(denomRaw) {
  return apiGet(`/api/pool_address/${denomRaw}`);
}

async function fetchEpoch() {
  const status = await apiGet("/api/status");
  return status.epoch;
}

async function runVelaCycleForWallet(sourceWallet, withdrawWallet, resume = false) {
  const denomRaw = nano.convert("0.1", { from: "NANO", to: "raw" });
  const poolInfo = await fetchPoolInfo(denomRaw);
  const poolPubkeyHex = poolInfo.pool_pubkey;
  const S_pub = hexToBytes(poolPubkeyHex);
  const P_w = hexToBytes(withdrawWallet.publicKey);
  const n = deriveSecretBytes(sourceWallet.seed, withdrawWallet.publicKey, "vela/n");
  const t = deriveSecretBytes(sourceWallet.seed, withdrawWallet.publicKey, "vela/t");
  const C = computeCommitment(n, t, P_w, S_pub);
  const C_hex = C.toString(16).padStart(64, "0");
  const nullifier = computeNullifier(n);

  let depositHash;
  let commitHash;

  const sourceInfo = await fetchAccountInfo(sourceWallet.address);
  const balance = BigInt(sourceInfo.balance);

  if (resume && balance < BigInt(denomRaw) + BigInt(1)) {
    const recovered = await findDepositCommitHashes(sourceWallet.address, poolPubkeyHex);
    if (!recovered) {
      throw new Error(`No deposit/commit pair found in history for ${sourceWallet.address}`);
    }
    depositHash = recovered.depositHash;
    commitHash = recovered.commitHash;
    console.log(`  recovered deposit hash: ${depositHash}`);
    console.log(`  recovered commit hash: ${commitHash}`);
  } else {
    if (balance < BigInt(denomRaw) + BigInt(1)) {
      throw new Error(`Insufficient balance in ${sourceWallet.address}: ${balance} raw`);
    }

    // Deposit block
    const depositBlock = buildBlock(sourceWallet.secretKey, {
      previous: sourceInfo.frontier,
      representative: sourceInfo.representative,
      balance: (balance - BigInt(denomRaw)).toString(),
      link: poolPubkeyHex,
      work: await computeWork(sourceInfo.frontier, SEND_THRESHOLD),
    });
    depositHash = depositBlock.hash;
    console.log(`  deposit hash: ${depositHash}`);
    await broadcastBlock(depositBlock.block);

    // Commitment block
    const commitBlock = buildBlock(sourceWallet.secretKey, {
      previous: depositHash,
      representative: sourceInfo.representative,
      balance: (balance - BigInt(denomRaw) - BigInt(1)).toString(),
      link: C_hex,
      work: await computeWork(depositHash, SEND_THRESHOLD),
    });
    commitHash = commitBlock.hash;
    console.log(`  commit hash: ${commitHash}`);
    await broadcastBlock(commitBlock.block);
  }

  // Submit to indexer
  const depositRes = await apiPost("/api/deposit", {
    deposit_hash: depositHash,
    commit_hash: commitHash,
  });
  console.log(`  indexer commitment: ${depositRes.commitment}`);

  // Withdraw using the epoch the indexer assigned to this deposit.
  const epoch = depositRes.epoch ?? (await fetchEpoch());
  const proofRes = await apiPost("/api/prove", {
    n: bytesToHex(n),
    t: bytesToHex(t),
    P_w: withdrawWallet.publicKey,
    nullifier: nullifier.toString(16),
    denomination: denomRaw,
    epoch,
  });
  if (!proofRes.proof || !proofRes.publicSignals) {
    throw new Error("Proof generation failed");
  }
  console.log(`  proof generated`);

  const withdrawRes = await apiPost("/api/withdraw", {
    destination: withdrawWallet.address,
    epoch,
    denomination: denomRaw,
    nullifier: nullifier.toString(16),
    proof: proofRes.proof,
    publicSignals: proofRes.publicSignals,
  });
  if (!withdrawRes.block || !withdrawRes.block_hash) {
    throw new Error("Guardian did not return a block");
  }
  console.log(`  guardian block hash: ${withdrawRes.block_hash}`);

  // PoW for a state block is computed on the previous block hash (pool frontier).
  const work = await computeWork(withdrawRes.block.previous, SEND_THRESHOLD);
  const signedBlock = { ...withdrawRes.block, work };
  await broadcastBlock(signedBlock);
  console.log(`  withdrawal broadcasted to ${withdrawWallet.address}`);
}

async function cmdVela(indexStr) {
  const index = Number(indexStr);
  if (Number.isNaN(index) || index < 0 || index > 9) {
    throw new Error("Provide a wallet index 0-9");
  }
  const { receivers } = loadWallets();
  const sourceWallet = receivers[index];
  const withdrawWallet = generateWallet(sourceWallet.seed, 1);
  console.log(`VELA cycle for wallet ${index}:`);
  console.log(`  source: ${sourceWallet.address}`);
  console.log(`  withdraw: ${withdrawWallet.address}`);
  await runVelaCycleForWallet(sourceWallet, withdrawWallet);
}

async function cmdVelaAll() {
  const { receivers } = loadWallets();
  for (let i = 0; i < receivers.length; i++) {
    console.log(`\n=== Wallet ${i} ===`);
    try {
      const sourceWallet = receivers[i];
      const withdrawWallet = generateWallet(sourceWallet.seed, 1);
      await runVelaCycleForWallet(sourceWallet, withdrawWallet);
    } catch (err) {
      console.error(`  FAILED: ${err.message}`);
    }
  }
}

async function cmdVelaRange(startStr, endStr, resume = false) {
  const start = Number(startStr);
  const end = Number(endStr);
  if (Number.isNaN(start) || Number.isNaN(end) || start < 0 || end > 9 || start > end) {
    throw new Error("Provide a valid range 0-9, e.g. 0 4");
  }
  const { receivers } = loadWallets();
  for (let i = start; i <= end; i++) {
    console.log(`\n=== Wallet ${i} ===`);
    try {
      const sourceWallet = receivers[i];
      const withdrawWallet = generateWallet(sourceWallet.seed, 1);
      await runVelaCycleForWallet(sourceWallet, withdrawWallet, resume);
    } catch (err) {
      console.error(`  FAILED: ${err.message}`);
    }
  }
}

async function cmdPrepareVela() {
  const { receivers } = loadWallets();
  // Standard Nano address derived from the guardian pool public key.
  const GUARDIAN_POOL = "nano_1sd1mjk1t9cynhn6z74rqu5fisu7szukkq9zs3oimiom6yqnekzff1dj4aqi";
  const ONE_RAW = "1";
  const amountRaw = nano.convert("0.1", { from: "NANO", to: "raw" });

  // Step 1: send 1 raw from funder wallet (i+5) to source wallet (i).
  // Skip funders that already sent their top-up (balance < 0.1 XNO).
  for (let i = 0; i < 5; i++) {
    const source = receivers[i];
    const funder = receivers[i + 5];
    const info = await fetchAccountInfo(funder.address);
    const balance = BigInt(info.balance);
    if (balance < BigInt(amountRaw)) {
      console.log(`Topup source ${i} from funder ${i + 5}: already sent`);
      continue;
    }
    const sendBlock = buildBlock(funder.secretKey, {
      previous: info.frontier,
      representative: funder.address,
      balance: (balance - BigInt(ONE_RAW)).toString(),
      link: source.address,
      work: await computeWork(info.frontier, SEND_THRESHOLD),
    });
    console.log(`Topup source ${i} from funder ${i + 5}: ${sendBlock.hash}`);
    await broadcastBlock(sendBlock.block);
  }

  // Step 2: source wallets receive the 1 raw top-up.
  // A source that already has more than 0.1 XNO has already received it.
  for (let i = 0; i < 5; i++) {
    const source = receivers[i];
    const info = await fetchAccountInfo(source.address);
    const balance = BigInt(info.balance);
    if (balance > BigInt(amountRaw)) {
      console.log(`Source ${i} receive topup: already received`);
      continue;
    }
    const pending = await fetchPending(source.address);
    const blocks = pending.blocks || {};
    const entries = Object.entries(blocks);
    const match = entries.find(([, b]) => String(b.amount) === ONE_RAW);
    if (!match) {
      console.log(`Source ${i}: no 1-raw pending block to receive`);
      continue;
    }
    const [sendHash] = match;
    const receiveBlock = buildBlock(source.secretKey, {
      previous: info.frontier,
      representative: info.representative,
      balance: (balance + BigInt(ONE_RAW)).toString(),
      link: sendHash,
      work: await computeWork(info.frontier, RECEIVE_THRESHOLD),
    });
    console.log(`Source ${i} receive topup: ${receiveBlock.hash}`);
    await broadcastBlock(receiveBlock.block);
  }

  // Step 3: funders send remaining balances to guardian pool.
  for (let i = 0; i < 5; i++) {
    const funder = receivers[i + 5];
    const info = await fetchAccountInfo(funder.address);
    const balance = BigInt(info.balance);
    if (balance <= 0n) {
      console.log(`Funder ${i + 5} empty`);
      continue;
    }
    const sendBlock = buildBlock(funder.secretKey, {
      previous: info.frontier,
      representative: funder.address,
      balance: "0",
      link: GUARDIAN_POOL,
      work: await computeWork(info.frontier, SEND_THRESHOLD),
    });
    console.log(`Funder ${i + 5} -> guardian: ${sendBlock.hash} (${nano.convert(balance.toString(), { from: "raw", to: "NANO" })} XNO)`);
    await broadcastBlock(sendBlock.block);
  }

  console.log("Prepare complete. Guardian pool funded and sources topped up.");
}

async function cmdSweep() {
  const data = loadWallets();
  const { receivers } = data;
  // Original sender from the funding receive block.
  const destination = "nano_3saqoz5qfgmohfz3dg5ywwmxj7dwdp3g6xfbspt11g7gyrxgbupi1w9u4g4r";
  console.log(`Sweeping all remaining balances back to ${destination}`);
  for (let i = 0; i < receivers.length; i++) {
    const wallet = receivers[i];
    try {
      const info = await fetchAccountInfo(wallet.address);
      const balance = BigInt(info.balance);
      if (balance <= 0n) {
        console.log(`  ${wallet.address}: empty`);
        continue;
      }
      const sendBlock = buildBlock(wallet.secretKey, {
        previous: info.frontier,
        representative: wallet.address,
        balance: "0",
        link: destination,
        work: await computeWork(info.frontier, SEND_THRESHOLD),
      });
      console.log(`  sweep ${i + 1}/${receivers.length}: ${sendBlock.hash} (${nano.convert(balance.toString(), { from: "raw", to: "NANO" })} XNO)`);
      await broadcastBlock(sendBlock.block);
    } catch (err) {
      console.error(`  ${wallet.address}: ${err.message}`);
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
    case "vela":
      await cmdVela(process.argv[3]);
      break;
    case "vela-all":
      await cmdVelaAll();
      break;
    case "vela-range":
      await cmdVelaRange(process.argv[3], process.argv[4]);
      break;
    case "vela-range-resume":
      await cmdVelaRange(process.argv[3], process.argv[4], true);
      break;
    case "prepare-vela":
      await cmdPrepareVela();
      break;
    case "sweep":
      await cmdSweep();
      break;
    default:
      console.log("Usage: node scripts/e2e-test.mjs <init|receive-funding|split|receive-split|status|vela <idx>|vela-all|vela-range <s> <e>|vela-range-resume <s> <e>|prepare-vela|sweep>");
      process.exit(1);
  }
}

main().catch((err) => {
  console.error("ERROR:", err.message);
  process.exit(1);
});
