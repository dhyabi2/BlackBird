import * as fs from "fs";
import * as path from "path";
import { poseidon9, poseidon3 } from "poseidon-lite";
import blakejs from "blakejs";
const { blake2b } = blakejs;
import { fileURLToPath } from "url";
import { loadTestWallets, encryptWallets, hasEncryptedStore } from "./wallet-store.mjs";
import {
  generateWallet,
  buildSendBlock,
  buildReceiveBlock,
  fetchAccountHistory,
  publicKeyToAddress,
  workHashForReceive,
  rawToNano,
  nanoToRaw,
  ZERO_HASH,
  SEND_THRESHOLD,
  RECEIVE_THRESHOLD,
  DEFAULT_REP,
} from "./nano.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const WALLETS_FILE = path.join(ROOT, "test-wallets.json.enc");
const BASE_URL = process.env.VELA_BASE_URL || "https://velav2-web.vercel.app";

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

async function generateWork(hash, subtype = "send") {
  const difficulty = subtype === "send" ? SEND_THRESHOLD : RECEIVE_THRESHOLD;
  // Optional local work provider (e.g. GPU work bridge) via WORK_URL env var.
  if (process.env.WORK_URL) {
    const res = await fetch(process.env.WORK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hash, difficulty }),
    });
    const data = await res.json();
    if (res.ok && data.work) return data.work;
    console.warn("WORK_URL failed, falling back to /api/work:", data.error || res.status);
  }
  const res = await apiPost("/api/work", { hash, difficulty });
  if (!res.work) throw new Error("Work generator did not return work");
  return res.work;
}

async function fetchAccountInfo(account) {
  return apiGet(`/api/account_info?account=${encodeURIComponent(account)}`);
}

async function fetchPending(account) {
  return apiGet(`/api/pending?account=${encodeURIComponent(account)}`);
}

async function broadcastBlock(block, subtype) {
  try {
    return await apiPost("/api/broadcast", { block, subtype });
  } catch (err) {
    // An "Old block" response means the exact block is already in the ledger,
    // which is equivalent to a successful broadcast.
    if (String(err.message).includes("Old block")) {
      return { old_block: true };
    }
    throw err;
  }
}

function isHex64(s) {
  return /^[0-9a-fA-F]{64}$/.test(s);
}

async function findDepositCommitHashes(sourceAddress, poolPubkeyHex) {
  // rpc.nano.to account_history omits subtype/link even with raw:true, so
  // match the deposit by destination account (the pool address) instead.
  const history = await fetchAccountHistory(sourceAddress, { count: 100 });
  const poolAddress = publicKeyToAddress(poolPubkeyHex.toUpperCase());
  for (let i = 0; i < history.length; i++) {
    const h = history[i];
    if (h.type !== "send" || h.account !== poolAddress) continue;
    // Commitment block is the next (newer) entry.
    if (i === 0) continue;
    const commit = history[i - 1];
    if (commit.type === "send") {
      return { depositHash: h.hash, commitHash: commit.hash };
    }
  }
  return null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForConfirmation(hashes, timeoutMs = 60_000, intervalMs = 3_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const blocks = await apiPost("/api/blocks_info", { hashes });
      if (hashes.every((h) => blocks[h]?.confirmed === "true")) return true;
    } catch {
      // keep polling
    }
    await sleep(intervalMs);
  }
  return false;
}

async function submitDepositWithRetry(depositHash, commitHash, maxAttempts = 12, intervalMs = 5_000) {
  let lastError;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      return await apiPost("/api/deposit", { deposit_hash: depositHash, commit_hash: commitHash });
    } catch (err) {
      lastError = err;
      const msg = String(err.message || err);
      if (!msg.toLowerCase().includes("invalid deposit/commit pair")) throw err;
      console.log(`  indexer not ready, retry ${i + 1}/${maxAttempts} ...`);
      if (i < maxAttempts - 1) await sleep(intervalMs);
    }
  }
  throw lastError;
}

function loadWallets() {
  if (!hasEncryptedStore()) {
    throw new Error(`No encrypted wallets file. Run: node scripts/e2e-test.mjs init`);
  }
  return loadTestWallets();
}

function saveWallets(wallets) {
  const password = process.env.VELA_TEST_WALLET_PASSWORD;
  if (!password) {
    throw new Error("VELA_TEST_WALLET_PASSWORD is required to save wallets");
  }
  fs.writeFileSync(WALLETS_FILE, encryptWallets(wallets, password));
}

async function cmdInit() {
  const fundingSeed = await generateSeed();
  const funding = generateWallet(fundingSeed, 0);
  const receivers = [];
  for (let i = 0; i < 10; i++) {
    const seed = await generateSeed();
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
  console.log(`\nSaved encrypted wallets to ${WALLETS_FILE}`);
  console.log("Set VELA_TEST_WALLET_PASSWORD in your environment to decrypt them.");
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

  const work = await generateWork(workHashForReceive(ZERO_HASH, funding.publicKey), "receive");
  const receiveBlock = buildReceiveBlock(funding.secretKey, {
    toAddress: funding.address,
    previous: ZERO_HASH,
    representative: funding.address,
    transactionHash: sendHash,
    balance: "0",
    amount: amountRaw,
    work,
  });
  console.log(`Open/receive hash: ${receiveBlock.hash}`);
  await broadcastBlock(receiveBlock.block, "receive");
  console.log("Funding receive broadcasted.");
}

async function reconstructSendHashesFromHistory(data) {
  const { funding, receivers } = data;
  const history = await fetchAccountHistory(funding.address);
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

  const amountRaw = nanoToRaw("0.1");
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
    const amount = BigInt(amountRaw);
    balance -= amount;
    const sendBlock = buildSendBlock(funding.secretKey, {
      fromAddress: funding.address,
      previous,
      representative: funding.address,
      balance: balance.toString(),
      link: receiver.address,
      amount: amount.toString(),
      work: await generateWork(previous, "send"),
    });
    console.log(`Send ${i + 1}/${receivers.length} to ${receiver.address}: ${sendBlock.hash}`);
    try {
      await broadcastBlock(sendBlock.block, "send");
    } catch (err) {
      if (String(err.message).includes("Old block")) {
        // The block may already be confirmed; recover its hash from history.
        const history = await fetchAccountHistory(funding.address);
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
  const amountRaw = nanoToRaw("0.1");
  for (let i = 0; i < receivers.length; i++) {
    const receiver = receivers[i];
    const sendHash = sendHashes[i].hash;
    console.log(`Receiving ${i + 1}/${receivers.length} for ${receiver.address} ...`);
    const work = await generateWork(workHashForReceive(ZERO_HASH, receiver.publicKey), "receive");
    const receiveBlock = buildReceiveBlock(receiver.secretKey, {
      toAddress: receiver.address,
      previous: ZERO_HASH,
      representative: receiver.address,
      transactionHash: sendHash,
      balance: "0",
      amount: amountRaw,
      work,
    });
    console.log(`  receive hash: ${receiveBlock.hash}`);
    await broadcastBlock(receiveBlock.block, "receive");
  }
  console.log("All 10 receives broadcasted.");
}

async function cmdStatus() {
  const { funding, receivers } = loadWallets();
  console.log("Funding:");
  try {
    const info = await fetchAccountInfo(funding.address);
    console.log(`  ${funding.address}: ${rawToNano(info.balance)} XNO`);
  } catch (e) {
    console.log(`  ${funding.address}: not opened / ${e.message}`);
  }
  console.log("Receivers:");
  for (const r of receivers) {
    try {
      const info = await fetchAccountInfo(r.address);
      console.log(`  ${r.address}: ${rawToNano(info.balance)} XNO`);
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
  const denomRaw = nanoToRaw("0.1");
  const poolInfo = await fetchPoolInfo(denomRaw);
  const poolPubkeyHex = poolInfo.pool_pubkey;
  const S_pub = hexToBytes(poolPubkeyHex);
  const P_w = hexToBytes(withdrawWallet.publicKey);
  // Denomination-scoped derivation (matches easy-wallet): keeps nullifiers
  // independent across denominations.
  const n = deriveSecretBytes(sourceWallet.seed, withdrawWallet.publicKey, `vela/n/${denomRaw}`);
  const t = deriveSecretBytes(sourceWallet.seed, withdrawWallet.publicKey, `vela/t/${denomRaw}`);
  const C = computeCommitment(n, t, P_w, S_pub);
  const C_hex = C.toString(16).padStart(64, "0");
  const nullifier = computeNullifier(n);

  // A (source, withdraw key) pair maps to one nullifier forever. Depositing
  // into a spent nullifier locks the funds, so refuse before broadcasting.
  const nullStatus = await apiGet(`/api/nullifier_status?nullifier=${nullifier.toString(16)}`).catch(() => null);
  if (nullStatus?.spent) {
    throw new Error(
      `Nullifier already spent for this source/withdraw pair. Use a different withdraw index (e.g. vela ${process.argv[3] ?? 0} <fresh-index>).`
    );
  }

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
    const depositBlock = buildSendBlock(sourceWallet.secretKey, {
      fromAddress: sourceWallet.address,
      previous: sourceInfo.frontier,
      representative: sourceInfo.representative,
      balance: (balance - BigInt(denomRaw)).toString(),
      link: poolPubkeyHex,
      amount: denomRaw,
      work: await generateWork(sourceInfo.frontier, "send"),
    });
    depositHash = depositBlock.hash;
    console.log(`  deposit hash: ${depositHash}`);
    await broadcastBlock(depositBlock.block, "send");

    // Commitment block
    const commitBlock = buildSendBlock(sourceWallet.secretKey, {
      fromAddress: sourceWallet.address,
      previous: depositHash,
      representative: sourceInfo.representative,
      balance: (balance - BigInt(denomRaw) - BigInt(1)).toString(),
      link: C_hex,
      amount: "1",
      work: await generateWork(depositHash, "send"),
    });
    commitHash = commitBlock.hash;
    console.log(`  commit hash: ${commitHash}`);
    await broadcastBlock(commitBlock.block, "send");
  }

  // Wait for on-chain confirmation before asking the indexer to accept the pair.
  console.log("  waiting for deposit/commit confirmation...");
  const confirmed = await waitForConfirmation([depositHash, commitHash]);
  if (!confirmed) {
    throw new Error("Deposit/commit blocks were not confirmed in time");
  }

  // Submit to indexer, retrying while the backend RPC catches up to rpc.nano.to.
  const depositRes = await submitDepositWithRetry(depositHash, commitHash);
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
  const workHash = typeof withdrawRes.block.previous === "string" ? withdrawRes.block.previous : withdrawRes.block_hash;
  const work = await generateWork(workHash, "send");
  const signedBlock = { ...withdrawRes.block, work };
  await broadcastBlock(signedBlock, "send");
  console.log(`  withdrawal broadcasted to ${withdrawWallet.address}`);
}

async function cmdVela(indexStr, withdrawIndexStr) {
  const index = Number(indexStr);
  if (Number.isNaN(index) || index < 0 || index > 9) {
    throw new Error("Provide a wallet index 0-9");
  }
  const withdrawIndex = withdrawIndexStr ? Number(withdrawIndexStr) : 1;
  if (Number.isNaN(withdrawIndex) || withdrawIndex < 1) {
    throw new Error("Withdraw index must be >= 1");
  }
  const { receivers } = loadWallets();
  const sourceWallet = receivers[index];
  const withdrawWallet = generateWallet(sourceWallet.seed, withdrawIndex);
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
  const amountRaw = nanoToRaw("0.1");

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
    const sendBlock = buildSendBlock(funder.secretKey, {
      fromAddress: funder.address,
      previous: info.frontier,
      representative: funder.address,
      balance: (balance - BigInt(ONE_RAW)).toString(),
      link: source.address,
      amount: ONE_RAW,
      work: await generateWork(info.frontier, "send"),
    });
    console.log(`Topup source ${i} from funder ${i + 5}: ${sendBlock.hash}`);
    await broadcastBlock(sendBlock.block, "send");
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
    const receiveBlock = buildReceiveBlock(source.secretKey, {
      toAddress: source.address,
      previous: info.frontier,
      representative: info.representative,
      transactionHash: sendHash,
      balance: balance.toString(),
      amount: ONE_RAW,
      work: await generateWork(info.frontier, "receive"),
    });
    console.log(`Source ${i} receive topup: ${receiveBlock.hash}`);
    await broadcastBlock(receiveBlock.block, "receive");
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
    const sendBlock = buildSendBlock(funder.secretKey, {
      fromAddress: funder.address,
      previous: info.frontier,
      representative: funder.address,
      balance: "0",
      link: GUARDIAN_POOL,
      amount: balance.toString(),
      work: await generateWork(info.frontier, "send"),
    });
    console.log(`Funder ${i + 5} -> guardian: ${sendBlock.hash} (${rawToNano(balance.toString())} XNO)`);
    await broadcastBlock(sendBlock.block, "send");
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
      const sendBlock = buildSendBlock(wallet.secretKey, {
        fromAddress: wallet.address,
        previous: info.frontier,
        representative: wallet.address,
        balance: "0",
        link: destination,
        amount: balance.toString(),
        work: await generateWork(info.frontier, "send"),
      });
      console.log(`  sweep ${i + 1}/${receivers.length}: ${sendBlock.hash} (${rawToNano(balance.toString())} XNO)`);
      await broadcastBlock(sendBlock.block, "send");
    } catch (err) {
      console.error(`  ${wallet.address}: ${err.message}`);
    }
  }
}

async function generateSeed() {
  const crypto = await import("crypto");
  return crypto.randomBytes(32).toString("hex").toUpperCase();
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
      await cmdVela(process.argv[3], process.argv[4]);
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
