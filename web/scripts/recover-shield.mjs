/**
 * Recover a shielded deposit whose withdrawal never completed.
 *
 * The original rpc.nano.to outage left deposits on-chain that the indexer could
 * not verify, so their withdrawals were never proven. The commitment is still in
 * the tree and the nullifier unspent, so the funds are recoverable: prove, ask
 * the guardian to sign, broadcast, receive, and send back to the source.
 *
 *   node scripts/recover-shield.mjs <withdrawIndex> [--dry-run]
 *
 * Refuses to act if the nullifier is already spent or the withdraw account has
 * already been paid — re-withdrawing a paid commitment would take funds that
 * are not ours from the pool.
 */
import * as fs from "fs";
import {
  generateWallet, buildSendBlock, buildReceiveBlock, rpcCall,
  workHashForReceive, rawToNano, ZERO_HASH, DEFAULT_REP,
} from "./nano.mjs";
import {
  apiGet, apiPost, generateWork, broadcastBlock, fetchAccountInfo,
  computeCommitment, computeNullifier, deriveSecretBytes, fetchPoolInfo,
  hexToBytes, bytesToHex, sleep,
} from "./e2e-test.mjs";

for (const line of fs.readFileSync("/opt/vela/.env.e2e.local", "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const idx = Number(process.argv[2]);
const dryRun = process.argv.includes("--dry-run");
if (!Number.isInteger(idx) || idx < 1) throw new Error("usage: recover-shield.mjs <withdrawIndex> [--dry-run]");

const DENOM = "100000000000000000000000000000";
const source = generateWallet(process.env.E2E_SOURCE_SEED, 0);
const withdraw = generateWallet(process.env.E2E_WITHDRAW_SEED, idx);

const pool = await fetchPoolInfo(DENOM);
const S_pub = hexToBytes(pool.pool_pubkey);
const P_w = hexToBytes(withdraw.publicKey);
const n = deriveSecretBytes(process.env.E2E_SOURCE_SEED, withdraw.publicKey, `vela/n/${DENOM}`);
const t = deriveSecretBytes(process.env.E2E_SOURCE_SEED, withdraw.publicKey, `vela/t/${DENOM}`);
const C = computeCommitment(n, t, P_w, S_pub);
const nullifier = computeNullifier(n);

console.log(`index ${idx} -> ${withdraw.address}`);

const status = await apiGet(`/api/deposit_status?commitment=${C.toString(16)}`).catch(() => null);
if (!status?.indexed) throw new Error("commitment is not indexed; nothing to recover here");
console.log(`  indexed: epoch=${status.epoch} leaf=${status.leaf_index}`);

const ns = await apiGet(`/api/nullifier_status?nullifier=${nullifier.toString(16)}`).catch(() => null);
if (ns?.spent) throw new Error("nullifier already spent — refusing");

// On-chain proof of non-payment. The guardian's bookkeeping can lag, so trust
// the ledger: an opened withdraw account means this commitment already paid out.
const acct = await rpcCall("account_info", { account: withdraw.address }).catch((e) => ({ error: e.message }));
const already = await rpcCall("receivable", { account: withdraw.address, count: "5" }).catch(() => ({}));
const alreadyBlocks = Array.isArray(already.blocks) ? already.blocks : Object.keys(already.blocks || {});
const resuming = alreadyBlocks.length > 0;
if (!acct.error && !resuming) throw new Error(`${withdraw.address} already has blocks — already paid, refusing`);
if (resuming) console.log("  withdrawal already broadcast; resuming at the receive leg");
else console.log("  withdraw account unopened: genuinely unpaid");

if (dryRun) { console.log("  DRY RUN — stopping before any broadcast"); process.exit(0); }

const proof = resuming ? null : await apiPost("/api/prove", {
  n: bytesToHex(n), t: bytesToHex(t), P_w: withdraw.publicKey,
  nullifier: nullifier.toString(16), denomination: DENOM, epoch: status.epoch,
});
if (!resuming && !proof.proof) throw new Error("proof generation failed");
if (!resuming) console.log("  proof generated");

const wr = resuming ? null : await apiPost("/api/withdraw", {
  destination: withdraw.address, epoch: status.epoch, denomination: DENOM,
  nullifier: nullifier.toString(16), proof: proof.proof, publicSignals: proof.publicSignals,
});
if (!resuming) {
  if (!wr.block) throw new Error("guardian did not return a block");
  console.log(`  guardian signed: ${wr.block_hash}`);
  const workHash = typeof wr.block.previous === "string" ? wr.block.previous : wr.block_hash;
  await broadcastBlock({ ...wr.block, work: await generateWork(workHash, "send") }, "send");
  console.log("  withdrawal broadcast");
}

// Receive at the fresh account, then sweep back to the source.
let got = null;
for (let i = 0; i < 24 && !got; i++) {
  const r = await rpcCall("receivable", { account: withdraw.address, count: "5" }).catch(() => ({}));
  // Without `source`, the node returns blocks as an ARRAY of hashes; with it,
  // an object keyed by hash. Object.keys() on the array would yield "0".
  const rb0 = r.blocks;
  const hashes = Array.isArray(rb0) ? rb0 : Object.keys(rb0 || {});
  if (hashes.length) got = hashes[0]; else await sleep(5000);
}
if (!got) throw new Error("withdrawal did not arrive");
const rb = buildReceiveBlock(withdraw.secretKey, {
  toAddress: withdraw.address, previous: ZERO_HASH, representative: DEFAULT_REP,
  balance: "0", transactionHash: got, amount: DENOM,
  work: await generateWork(workHashForReceive(ZERO_HASH, withdraw.publicKey), "receive"),
});
await broadcastBlock(rb.block, "receive");
console.log("  received");

const info = await fetchAccountInfo(withdraw.address);
const sb = buildSendBlock(withdraw.secretKey, {
  fromAddress: withdraw.address, previous: info.frontier,
  representative: info.representative || DEFAULT_REP, balance: "0",
  link: source.address, amount: info.balance,
  work: await generateWork(info.frontier, "send"),
});
await broadcastBlock(sb.block, "send");
console.log(`  returned ${rawToNano(info.balance)} XNO to ${source.address}`);
