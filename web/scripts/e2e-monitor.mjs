/**
 * Hourly end-to-end probe for BlackBird.
 *
 * One run exercises the whole user-visible path with real money on the real
 * network, then puts the money back where it started:
 *
 *   1. shield   wallet A sends 0.1 XNO to the pool + a commitment block
 *   2. index    the indexer accepts the deposit/commit pair
 *   3. prove    a zk proof is generated for the commitment
 *   4. withdraw the guardian signs a pool send to a fresh account B[i]
 *   5. receive  B[i] receives the withdrawal
 *   6. return   B[i] sends the full balance back to A  <-- return to sender
 *
 * Because step 6 returns the funds, a single funding of wallet A covers many
 * runs; only proof-of-work and the 1 raw commitment leave the pair.
 *
 * The withdraw account uses a FRESH index each run. The nullifier is derived
 * from (A.seed, B[i].publicKey, denomination), so reusing one withdraw account
 * would make every run after the first fail with "nullifier already spent" —
 * a monitor bug that would look exactly like a real outage.
 *
 * Writes a status document that /api/e2e-status serves to the website, so users
 * see a warning banner instead of walking into a broken deposit.
 *
 *   node scripts/e2e-monitor.mjs          run one probe
 *   node scripts/e2e-monitor.mjs --status print the last recorded result
 */
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

import {
  generateWallet,
  buildSendBlock,
  buildReceiveBlock,
  workHashForReceive,
  rawToNano,
  ZERO_HASH,
  DEFAULT_REP,
} from "./nano.mjs";
import {
  runVelaCycleForWallet,
  fetchAccountInfo,
  fetchPending,
  generateWork,
  broadcastBlock,
  sleep,
} from "./e2e-test.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(ROOT, "..");

const STATE_FILE =
  process.env.E2E_STATE_FILE || path.join(REPO_ROOT, "data", "e2e-monitor.json");

/** A probe that has not finished inside this budget is a failure: a deposit the
 * user cannot complete in 12 minutes is indistinguishable from a broken one. */
const RUN_TIMEOUT_MS = Number(process.env.E2E_TIMEOUT_MS || 12 * 60 * 1000);

/** Below this, wallet A can no longer fund a 0.1 XNO shield + PoW headroom. */
const LOW_BALANCE_RAW = BigInt("150000000000000000000000000000"); // 0.15 XNO

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    if (process.env[m[1]]) continue; // real env wins
    process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

loadEnvFile(path.join(REPO_ROOT, ".env.e2e.local"));

function requireEnv(name) {
  const v = (process.env[name] || "").trim();
  if (!v) {
    throw new Error(
      `${name} is not set. Copy .env.e2e.local into place (or export it) before running the probe.`
    );
  }
  return v;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { run: 0, history: [] };
  }
}

function writeState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ---------------------------------------------------------------------------
// Return-to-sender leg
// ---------------------------------------------------------------------------

/** Wait for `account` to see a pending block, then receive it. */
async function receivePending(wallet, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pending = await fetchPending(wallet.address).catch(() => null);
    const blocks = pending?.blocks;
    const hashes = blocks
      ? Array.isArray(blocks)
        ? blocks
        : Object.keys(blocks)
      : [];
    if (hashes.length > 0) {
      const hash = hashes[0];
      const amount = Array.isArray(blocks) ? null : blocks[hash]?.amount;

      // A brand-new account has no frontier: open it instead of receiving onto
      // one, and hash the work over the public key rather than the frontier.
      const info = await fetchAccountInfo(wallet.address).catch(() => null);
      const previous = info?.frontier || ZERO_HASH;
      const balance = BigInt(info?.balance || "0");
      const representative = info?.representative || DEFAULT_REP;

      const receiveBlock = buildReceiveBlock(wallet.secretKey, {
        toAddress: wallet.address,
        previous,
        representative,
        balance: balance.toString(),
        transactionHash: hash,
        amount: amount ?? "0",
        work: await generateWork(
          workHashForReceive(previous, wallet.publicKey),
          "receive"
        ),
      });
      await broadcastBlock(receiveBlock.block, "receive");
      return { hash: receiveBlock.hash, sourceHash: hash };
    }
    await sleep(5_000);
  }
  throw new Error(`No pending block arrived at ${wallet.address} in time`);
}

/** Send everything `from` holds back to `toAddress`. */
async function returnToSender(from, toAddress) {
  const info = await fetchAccountInfo(from.address);
  const balance = BigInt(info.balance);
  if (balance === BigInt(0)) {
    throw new Error(`Nothing to return: ${from.address} holds 0 raw`);
  }
  const sendBlock = buildSendBlock(from.secretKey, {
    fromAddress: from.address,
    previous: info.frontier,
    representative: info.representative || DEFAULT_REP,
    balance: "0", // sweep the account empty
    link: toAddress,
    amount: balance.toString(),
    work: await generateWork(info.frontier, "send"),
  });
  await broadcastBlock(sendBlock.block, "send");
  return { hash: sendBlock.hash, amountRaw: balance.toString() };
}

// ---------------------------------------------------------------------------
// Probe
// ---------------------------------------------------------------------------

async function runProbe() {
  const sourceSeed = requireEnv("E2E_SOURCE_SEED");
  const withdrawSeed = requireEnv("E2E_WITHDRAW_SEED");

  const state = readState();
  const runIndex = (state.run || 0) + 1;

  const source = generateWallet(sourceSeed, 0);
  // Fresh withdraw account per run => fresh nullifier. See file header.
  const withdraw = generateWallet(withdrawSeed, runIndex);

  const steps = [];
  const startedAt = new Date().toISOString();
  const t0 = Date.now();

  const step = async (name, fn) => {
    const s0 = Date.now();
    try {
      const detail = await fn();
      steps.push({ name, ok: true, ms: Date.now() - s0, ...(detail || {}) });
      return detail;
    } catch (err) {
      steps.push({ name, ok: false, ms: Date.now() - s0, error: err.message });
      throw Object.assign(err, { step: name });
    }
  };

  let sourceBalanceRaw = "0";
  let result;

  try {
    await step("preflight", async () => {
      let info = await fetchAccountInfo(source.address).catch(() => null);
      let balance = BigInt(info?.balance ?? "0");

      // A top-up arrives as a *pending* block, and a first-ever funding leaves
      // the account unopened entirely. Receive anything outstanding so the probe
      // can bootstrap itself from a fresh funding instead of demanding the
      // operator receive it by hand.
      const pending = await fetchPending(source.address).catch(() => null);
      const pendingBlocks = pending?.blocks;
      const hasPending = pendingBlocks
        ? (Array.isArray(pendingBlocks) ? pendingBlocks : Object.keys(pendingBlocks))
            .length > 0
        : false;

      if (hasPending && balance < LOW_BALANCE_RAW) {
        await receivePending(source);
        info = await fetchAccountInfo(source.address).catch(() => null);
        balance = BigInt(info?.balance ?? "0");
      }

      if (!info || !info.frontier) {
        throw new Error(
          `Source wallet ${source.address} is unopened and has nothing pending — fund it with at least 0.2 XNO`
        );
      }

      sourceBalanceRaw = info.balance;
      if (balance < LOW_BALANCE_RAW) {
        throw new Error(
          `Source wallet is low: ${rawToNano(info.balance)} XNO. Top up ${source.address}`
        );
      }
      return { balance_nano: rawToNano(info.balance) };
    });

    // Steps 1-4: shield, index, prove, withdraw.
    result = await step("shield_and_withdraw", async () => {
      const cycle = await runVelaCycleForWallet(source, withdraw);
      return {
        epoch: cycle.epoch,
        deposit_hash: cycle.depositHash,
        commit_hash: cycle.commitHash,
        withdraw_block: cycle.withdrawBlockHash,
      };
    });

    // Step 5: the withdrawal actually lands.
    await step("receive_withdrawal", async () => {
      const r = await receivePending(withdraw);
      return { receive_hash: r.hash };
    });

    // Step 6: return to sender — what the user asked for. Without this the
    // probe would bleed 0.1 XNO an hour into throwaway accounts.
    await step("return_to_sender", async () => {
      const r = await returnToSender(withdraw, source.address);
      return { return_hash: r.hash, returned_nano: rawToNano(r.amountRaw) };
    });

    await step("source_receives_return", async () => {
      const r = await receivePending(source);
      return { receive_hash: r.hash };
    });
  } catch {
    // Swallow: the failure is already recorded in `steps` and reported below.
  }

  const failed = steps.find((s) => !s.ok);
  const totalMs = Date.now() - t0;
  const timedOut = totalMs > RUN_TIMEOUT_MS;

  return {
    ok: !failed && !timedOut,
    run: runIndex,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    duration_ms: totalMs,
    timed_out: timedOut,
    denomination_nano: "0.1",
    source_address: source.address,
    source_balance_nano: rawToNano(sourceBalanceRaw),
    withdraw_address: withdraw.address,
    withdraw_index: runIndex,
    epoch: result?.epoch ?? null,
    failed_step: failed?.name ?? (timedOut ? "timeout" : null),
    error: failed?.error ?? (timedOut ? `Probe exceeded ${RUN_TIMEOUT_MS}ms` : null),
    steps,
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main() {
  if (process.argv.includes("--status")) {
    console.log(JSON.stringify(readState().last ?? { ok: null }, null, 2));
    return;
  }

  let report;
  try {
    report = await runProbe();
  } catch (err) {
    // Config errors (missing seeds) never reach runProbe's internal handler.
    report = {
      ok: false,
      run: readState().run || 0,
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
      failed_step: "config",
      error: err.message,
      steps: [],
    };
  }

  const state = readState();
  state.run = report.run;
  state.last = report;
  state.history = [report, ...(state.history || [])].slice(0, 48); // ~2 days
  writeState(state);

  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) {
    console.error(`E2E PROBE FAILED at ${report.failed_step}: ${report.error}`);
    process.exit(1);
  }
  console.log(`E2E probe OK in ${(report.duration_ms / 1000).toFixed(1)}s`);
}

main().catch((err) => {
  console.error("ERROR:", err.message);
  process.exit(1);
});
