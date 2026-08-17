// Small-budget e2e driver: moves XNO between the test wallets using a local
// work provider (WORK_URL) and direct RPC. Complements e2e-test.mjs, which
// assumes a 1 XNO budget.
//
// Usage: node scripts/e2e-driver.mjs <open-funding|send A B amountNano|receive B|status>
// Wallet names: funding, r0..r9, w0..w9 (withdraw wallet i = receivers[i].seed index 1)
import {
  generateWallet,
  buildSendBlock,
  buildReceiveBlock,
  rpcCall,
  workHashForReceive,
  rawToNano,
  nanoToRaw,
  ZERO_HASH,
  SEND_THRESHOLD,
  RECEIVE_THRESHOLD,
} from "./nano.mjs";
import { loadTestWallets } from "./wallet-store.mjs";

const WORK_URL = process.env.WORK_URL || "http://127.0.0.1:8901/work";

async function generateWork(hash, subtype) {
  const difficulty = subtype === "send" ? SEND_THRESHOLD : RECEIVE_THRESHOLD;
  const res = await fetch(WORK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ hash, difficulty }),
  });
  const data = await res.json();
  if (!res.ok || !data.work) throw new Error(`work bridge failed: ${data.error || res.status}`);
  return data.work;
}

function resolveWallet(name) {
  const store = loadTestWallets();
  if (name === "funding") return store.funding;
  let m = name.match(/^r(\d)$/);
  if (m) return store.receivers[Number(m[1])];
  m = name.match(/^w(\d)(?::(\d+))?$/);
  if (m) return generateWallet(store.receivers[Number(m[1])].seed, m[2] ? Number(m[2]) : 1);
  throw new Error(`Unknown wallet name: ${name}`);
}

async function accountInfo(address) {
  const info = await rpcCall("account_info", { account: address, representative: "true" });
  if (info.error === "Account not found") return null;
  return info;
}

async function broadcast(block, subtype) {
  const res = await rpcCall("process", { json_block: "true", subtype, block });
  return res.hash;
}

async function cmdSend(fromName, toName, amountNano) {
  const from = resolveWallet(fromName);
  const to = resolveWallet(toName);
  const info = await accountInfo(from.address);
  if (!info) throw new Error(`${fromName} not opened`);
  const amount = BigInt(nanoToRaw(amountNano));
  const balance = BigInt(info.balance);
  if (balance < amount) throw new Error(`${fromName} balance ${balance} < ${amount}`);
  const block = buildSendBlock(from.secretKey, {
    fromAddress: from.address,
    previous: info.frontier,
    representative: info.representative,
    balance: (balance - amount).toString(),
    link: to.address,
    amount: amount.toString(),
    work: await generateWork(info.frontier, "send"),
  });
  const hash = await broadcast(block.block, "send");
  console.log(`send ${fromName} -> ${toName} ${amountNano} XNO: ${hash}`);
}

async function cmdReceive(name) {
  const wallet = resolveWallet(name);
  const pending = await rpcCall("receivable", { account: wallet.address, count: "10", source: "true" });
  const blocks = pending.blocks || {};
  const hashes = Object.keys(blocks);
  if (hashes.length === 0) { console.log(`${name}: nothing receivable`); return; }
  for (const sendHash of hashes) {
    const info = await accountInfo(wallet.address);
    const previous = info?.frontier ?? ZERO_HASH;
    const balance = info?.balance ?? "0";
    const rep = info?.representative ?? wallet.address;
    const amount = blocks[sendHash].amount ?? blocks[sendHash];
    const block = buildReceiveBlock(wallet.secretKey, {
      toAddress: wallet.address,
      previous,
      representative: rep,
      transactionHash: sendHash,
      balance,
      amount: String(amount),
      work: await generateWork(workHashForReceive(previous, wallet.publicKey), "receive"),
    });
    const hash = await broadcast(block.block, "receive");
    console.log(`receive ${name} <- ${sendHash.slice(0, 12)}... (${rawToNano(String(amount))} XNO): ${hash}`);
  }
}

async function cmdStatus() {
  const store = loadTestWallets();
  const rows = [["funding", store.funding]];
  store.receivers.forEach((r, i) => rows.push([`r${i}`, r]));
  store.receivers.forEach((r, i) => rows.push([`w${i}`, generateWallet(r.seed, 1)]));
  for (const [name, w] of rows) {
    const bal = await rpcCall("account_balance", { account: w.address });
    const b = BigInt(bal.balance ?? "0");
    const p = BigInt(bal.receivable ?? bal.pending ?? "0");
    if (b > 0n || p > 0n) {
      console.log(`${name} ${w.address}: ${rawToNano(b.toString())} XNO (receivable ${rawToNano(p.toString())})`);
    }
  }
}

const [cmd, ...args] = process.argv.slice(2);
switch (cmd) {
  case "send": await cmdSend(args[0], args[1], args[2]); break;
  case "receive": await cmdReceive(args[0]); break;
  case "status": await cmdStatus(); break;
  default:
    console.log("Usage: node scripts/e2e-driver.mjs <send from to amountNano | receive name | status>");
}
