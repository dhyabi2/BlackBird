"use client";

import "@/lib/polyfills";
import { useCallback, useEffect, useMemo, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import {
  deriveLegacyAccount,
  buildSendBlock,
  buildReceiveBlock,
  rawToNano,
  nanoToRaw,
  validateWork,
} from "@/lib/wallet";
import { encryptSeed, decryptSeed } from "@/lib/crypto-storage";
import { createBackupPhrase, phraseToSeedHex } from "@/lib/mnemonic";
import { computeCommitment, computeNullifier, hexToBytes, bytesToHex } from "@/lib/vela-crypto";
import { blake2b } from "blakejs";

import { Button } from "@/components/ui/Button";
import { CopyButton } from "@/components/ui/CopyButton";
import { useNanoWebsocket } from "@/lib/nano-ws";
import { ALLOWED_DENOMINATIONS } from "@/lib/denominations";

const STORAGE_KEY = "blackbird_wallet_v1";
const SESSION_SEED_KEY = "blackbird_session_seed";
const LEGACY_STORAGE_KEY = "vela_wallet_v1";
const ZERO_HASH = "0000000000000000000000000000000000000000000000000000000000000000";
const DEFAULT_REP = "nano_3jwrszth46rk1mu7rmb4rhm54us8yg1gw3ipodftqtikf5yqdyr7471nsg1k";
const SEND_THRESHOLD = "fffffff800000000";
const RECEIVE_THRESHOLD = "fffffe0000000000";

function workHashForReceive(previous: string, publicKey: string): string {
  // For an open (first) receive block, work is generated on the account public key.
  return previous === ZERO_HASH ? publicKey : previous;
}

async function generateWork(hash: string, subtype: "send" | "receive"): Promise<string> {
  if (!hash || typeof hash !== "string") {
    throw new Error(`DEPOSIT-WORK: Invalid work hash (${typeof hash})`);
  }
  const difficulty = subtype === "send" ? SEND_THRESHOLD : RECEIVE_THRESHOLD;
  const res = await apiPost("/api/work", { hash, difficulty });
  if (!res.work || !/^[0-9a-fA-F]{16}$/.test(res.work)) {
    throw new Error("Work generator returned an invalid work value");
  }
  return res.work;
}

const DENOMINATIONS = [
  { raw: ALLOWED_DENOMINATIONS[0], label: "0.1 XNO" },
  { raw: ALLOWED_DENOMINATIONS[1], label: "1 XNO" },
  { raw: ALLOWED_DENOMINATIONS[2], label: "10 XNO" },
  { raw: ALLOWED_DENOMINATIONS[3], label: "100 XNO" },
];

function deriveSecretBytes(seedHex: string, P_w_hex: string, salt: string): Uint8Array {
  const seedBytes = hexToBytes(seedHex);
  const PwBytes = hexToBytes(P_w_hex);
  const saltBytes = new TextEncoder().encode(salt);
  const input = new Uint8Array(seedBytes.length + PwBytes.length + saltBytes.length);
  input.set(seedBytes, 0);
  input.set(PwBytes, seedBytes.length);
  input.set(saltBytes, seedBytes.length + PwBytes.length);
  return blake2b(input, undefined, 32) as Uint8Array;
}

function nano(raw: bigint): string {
  const full = rawToNano(raw.toString());
  if (!full.includes(".")) return full;
  const trimmed = full.replace(/0+$/, "").replace(/\.$/, "");
  return trimmed;
}

function withdrawFeeRaw(denominationRaw: bigint, bps: number): bigint {
  return (denominationRaw * BigInt(bps)) / BigInt(10_000);
}

// Mobile wallets such as Natrium only display amounts to 6 decimal places.
// Ask for denomination + 0.000001 XNO so the QR code auto-fills an amount
// the wallet can actually send. The protocol still only consumes
// denomination + 1 raw; the remainder stays as dust in the shield address.
const WALLET_FRIENDLY_PADDING_RAW = BigInt(10) ** BigInt(24); // 0.000001 XNO

function explorerLink(hash: string) {
  return `https://nanolooker.com/block/${hash}`;
}

async function apiPost(path: string, body: unknown) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`${path}: ${data.error || `Request failed: ${res.status}`}`);
  return data;
}

async function apiGet(path: string) {
  const res = await fetch(path);
  const data = await res.json();
  if (!res.ok) throw new Error(`${path}: ${data.error || `Request failed: ${res.status}`}`);
  return data;
}

async function waitForConfirmation(hashes: string[], timeoutMs = 60_000, intervalMs = 3_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const blocks = (await apiPost("/api/blocks_info", { hashes })) as Record<string, { confirmed?: string }>;
      if (hashes.every((h) => blocks[h]?.confirmed === "true")) return true;
    } catch {
      // keep polling
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

async function submitDepositWithRetry(
  depositHash: string,
  commitHash: string,
  setStatus: (msg: string | null) => void,
  maxAttempts = 12,
  intervalMs = 5_000
) {
  let lastError: unknown;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      return await apiPost("/api/deposit", {
        deposit_hash: depositHash,
        commit_hash: commitHash,
      });
    } catch (err) {
      lastError = err;
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.toLowerCase().includes("invalid deposit/commit pair")) throw err;
      if (i < maxAttempts - 1) {
        setStatus(`Waiting for indexer to see the deposit/commit pair... (${i + 1}/${maxAttempts})`);
        await new Promise((r) => setTimeout(r, intervalMs));
      }
    }
  }
  throw lastError;
}

function recommendDenomination(balanceRaw: string | null, pendingRaw: string | null): string {
  const total = BigInt(balanceRaw ?? "0") + BigInt(pendingRaw ?? "0");
  for (const d of [...DENOMINATIONS].reverse()) {
    if (total >= BigInt(d.raw) + BigInt(1)) return d.raw;
  }
  return DENOMINATIONS[0].raw;
}

export default function EasyWallet() {
  const [password, setPassword] = useState("");
  const [passwordConfirm, setPasswordConfirm] = useState("");
  const [phrase, setPhrase] = useState("");
  const [seed, setSeed] = useState<string | null>(null);
  const [stored, setStored] = useState<string | null>(null);
  const [view, setView] = useState<"locked" | "create" | "restore" | "dashboard">("locked");
  const [error, setError] = useState<string | null>(null);

  const [sourceIndex] = useState(0);
  const [withdrawIndex, setWithdrawIndex] = useState(1);
  const [denomRaw, setDenomRaw] = useState(DENOMINATIONS[0].raw);
  const [denomManuallyChanged, setDenomManuallyChanged] = useState(false);
  const [epoch, setEpoch] = useState<number | null>(null);
  const [balance, setBalance] = useState<string | null>(null);
  const [pendingRaw, setPendingRaw] = useState<string | null>(null);
  const [pendingBlocks, setPendingBlocks] = useState<Record<string, { amount: string; source: string }>>({});
  const [sourceInfo, setSourceInfo] = useState<{ frontier?: string | null; representative?: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [lastWithdrawAddress, setLastWithdrawAddress] = useState<string | null>(null);
  const [depositDone, setDepositDone] = useState(false);
  const [withdrawReady, setWithdrawReady] = useState(false);
  const [depositTx, setDepositTx] = useState<{ depositHash: string; commitHash: string } | null>(null);
  const [withdrawTx, setWithdrawTx] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [greenlight, setGreenlight] = useState<{ ok: boolean; error?: string } | null>(null);
  const [feeBps, setFeeBps] = useState(0);

  useEffect(() => {
    if (typeof window === "undefined") return;

    // Migrate wallets saved under the old VELA branding key.
    try {
      const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
      if (legacy && !localStorage.getItem(STORAGE_KEY)) {
        localStorage.setItem(STORAGE_KEY, legacy);
        localStorage.removeItem(LEGACY_STORAGE_KEY);
      }
    } catch {
      // ignore storage errors
    }

    const saved = (() => {
      try {
        return localStorage.getItem(STORAGE_KEY);
      } catch {
        return null;
      }
    })();
    const sessionSeed = (() => {
      try {
        return sessionStorage.getItem(SESSION_SEED_KEY);
      } catch {
        return null;
      }
    })();

    if (sessionSeed) {
      setSeed(sessionSeed);
      setView("dashboard");
    } else if (saved) {
      setStored(saved);
      setView("locked");
    } else {
      setView("create");
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (seed) {
      sessionStorage.setItem(SESSION_SEED_KEY, seed);
    }
  }, [seed]);

  useEffect(() => {
    apiGet("/api/status")
      .then((s) => setEpoch(s.epoch ?? null))
      .catch(() => null);

    // Strict backend green-light check before allowing any deposit.
    apiGet("/api/greenlight")
      .then(() => setGreenlight({ ok: true }))
      .catch((err) => setGreenlight({ ok: false, error: err instanceof Error ? err.message : "Network check failed" }));

    // Load the current guardian fee policy from the backend so the UI always matches.
    apiGet("/api/fee")
      .then((c) => {
        if (typeof c.fee_bps === "number" && c.fee_bps >= 0) {
          setFeeBps(c.fee_bps);
        }
      })
      .catch(() => null);
  }, []);

  const source = useMemo(() => (seed ? deriveLegacyAccount(seed, sourceIndex) : null), [seed, sourceIndex]);
  const withdraw = useMemo(() => (seed ? deriveLegacyAccount(seed, withdrawIndex) : null), [seed, withdrawIndex]);

  const refreshBalanceAndPending = useCallback(async () => {
    if (!source) return;
    try {
      const [info, pending] = await Promise.all([
        apiGet(`/api/account_info?account=${encodeURIComponent(source.address)}`),
        apiGet(`/api/pending?account=${encodeURIComponent(source.address)}`).catch(() => ({ blocks: {} })),
      ]);
      setBalance(info.balance ?? "0");
      setSourceInfo({ frontier: info.frontier ?? null, representative: info.representative ?? null });

      const blocks = pending.blocks;
      const map: Record<string, { amount: string; source: string }> = {};
      let pendingSum = BigInt(0);
      if (blocks && typeof blocks === "object") {
        for (const [hash, block] of Object.entries(blocks as Record<string, { amount: string; source: string }>)) {
          map[hash] = block;
          pendingSum += BigInt(block.amount ?? "0");
        }
      }
      setPendingBlocks(map);
      setPendingRaw(pendingSum.toString());
    } catch {
      setBalance(null);
      setPendingRaw(null);
      setPendingBlocks({});
      setSourceInfo(null);
    }
  }, [source]);

  // Polling fallback for balance/pending.
  useEffect(() => {
    if (!source) return;
    let alive = true;
    async function tick() {
      if (!alive) return;
      await refreshBalanceAndPending();
    }
    tick();
    const id = setInterval(tick, 5_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [source, refreshBalanceAndPending]);

  // Real-time websocket detection for incoming sends.
  useNanoWebsocket(source?.address ?? null, source?.publicKey ?? null, (amount) => {
    log(`Live: incoming ${nano(BigInt(amount))} XNO detected`);
    void refreshBalanceAndPending();
  });

  // Recommend denomination based on available funds unless the user picked one.
  const effectiveDenom = useMemo(() => {
    if (denomManuallyChanged || busy || depositDone) return denomRaw;
    return recommendDenomination(balance, pendingRaw);
  }, [denomManuallyChanged, busy, depositDone, denomRaw, balance, pendingRaw]);

  function log(msg: string) {
    setLogs((prev) => [...prev, `${new Date().toLocaleTimeString()} ${msg}`]);
  }

  function lock() {
    setSeed(null);
    setView("locked");
    setPassword("");
    if (typeof window !== "undefined") {
      sessionStorage.removeItem(SESSION_SEED_KEY);
    }
  }

  async function handleCreate() {
    setError(null);
    if (password.length < 8) {
      setError("Password must be at least 8 characters");
      return;
    }
    if (password !== passwordConfirm) {
      setError("Passwords do not match");
      return;
    }
    const newPhrase = createBackupPhrase();
    const newSeed = phraseToSeedHex(newPhrase);
    const encrypted = await encryptSeed(newSeed, password);
    localStorage.setItem(STORAGE_KEY, encrypted);
    setStored(encrypted);
    setPhrase(newPhrase);
    setSeed(newSeed);
    setView("dashboard");
    log("Wallet created. Save your recovery phrase!");
  }

  async function handleRestore() {
    setError(null);
    if (password.length < 8) {
      setError("Password must be at least 8 characters");
      return;
    }
    try {
      const restoredSeed = phraseToSeedHex(phrase.trim());
      const encrypted = await encryptSeed(restoredSeed, password);
      localStorage.setItem(STORAGE_KEY, encrypted);
      setStored(encrypted);
      setSeed(restoredSeed);
      setView("dashboard");
      log("Wallet restored.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invalid phrase");
    }
  }

  async function handleUnlock() {
    setError(null);
    if (!stored) return;
    try {
      const unlocked = await decryptSeed(stored, password);
      setSeed(unlocked);
      setView("dashboard");
      log("Wallet unlocked.");
    } catch {
      setError("Wrong password");
    }
  }

  async function waitForBalance(targetRaw: string, timeoutMs = 60_000): Promise<boolean> {
    const target = BigInt(targetRaw);
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      await new Promise((r) => setTimeout(r, 2_000));
      try {
        const info = await apiGet(`/api/account_info?account=${encodeURIComponent(source!.address)}`);
        setBalance(info.balance ?? "0");
        setSourceInfo({ frontier: info.frontier ?? null, representative: info.representative ?? null });
        if (BigInt(info.balance ?? "0") >= target) return true;
      } catch {
        // keep waiting
      }
    }
    return false;
  }

  async function receivePending(requiredRaw: bigint): Promise<boolean> {
    if (!source || !sourceInfo) return false;
    const currentBalance = BigInt(balance ?? "0");
    if (currentBalance >= requiredRaw) return true;

    const entries = Object.entries(pendingBlocks);
    if (entries.length === 0) return false;

    // Prefer a single pending send that covers the shortfall.
    let chosenHash: string | null = null;
    let chosenAmount = BigInt(0);
    for (const [hash, block] of entries) {
      const amt = BigInt(block.amount ?? "0");
      if (currentBalance + amt >= requiredRaw) {
        chosenHash = hash;
        chosenAmount = amt;
        break;
      }
    }
    // Otherwise pick the largest pending send.
    if (!chosenHash) {
      for (const [hash, block] of entries) {
        const amt = BigInt(block.amount ?? "0");
        if (amt > chosenAmount) {
          chosenAmount = amt;
          chosenHash = hash;
        }
      }
    }
    if (!chosenHash) return false;

    let rep: string | null | undefined = sourceInfo.representative;
    if (!rep) {
      // Opening the account: use the sender's representative, falling back to a default.
      const sender = pendingBlocks[chosenHash].source;
      const senderInfo = await apiGet(`/api/account_info?account=${encodeURIComponent(sender)}`).catch(() => null);
      rep = senderInfo?.representative || DEFAULT_REP;
    }
    const representative = rep || DEFAULT_REP;

    const isOpen = !sourceInfo.frontier;
    const previous = isOpen ? ZERO_HASH : sourceInfo.frontier!;
    const workHash = workHashForReceive(previous, source.publicKey);
    let work = await generateWork(workHash, "receive");
    const newBalance = (currentBalance + chosenAmount).toString();

    const receiveBlock = buildReceiveBlock(source.secretKey, {
      toAddress: source.address,
      previous,
      representative,
      transactionHash: chosenHash,
      balance: currentBalance.toString(),
      amount: chosenAmount.toString(),
      work,
    });

    // Validate the work against the actual block hash before broadcasting.
    const blockPrevious = String(receiveBlock.block.previous);
    if (!validateWork(work, blockPrevious, RECEIVE_THRESHOLD)) {
      log(`WARN: Work invalid for block previous; retrying work generation`);
      work = await generateWork(blockPrevious, "receive");
      (receiveBlock.block as Record<string, unknown>).work = work;
      if (!validateWork(work, blockPrevious, RECEIVE_THRESHOLD)) {
        throw new Error("RECEIVE-WORK: Generated work is invalid for receive block");
      }
    }

    log(`Receive hash: ${receiveBlock.hash}`);
    log(`Receive work hash: ${workHash}, block previous: ${blockPrevious}, isOpen: ${isOpen}`);
    await apiPost("/api/broadcast", { block: receiveBlock.block, subtype: "receive" });
    log("Receive broadcasted");

    return waitForBalance(newBalance);
  }

  async function handleDeposit() {
    if (!source || !withdraw || !sourceInfo) return;
    setBusy(true);
    setStatusMessage("Preparing deposit...");
    setWithdrawReady(false);
    try {
      const denom = BigInt(effectiveDenom);
      const required = denom + BigInt(1);
      let bal = BigInt(balance ?? "0");

      // Auto-receive pending sends if the source balance is not yet spendable.
      let currentSourceInfo = sourceInfo;
      if (bal < required) {
        const pendingSum = BigInt(pendingRaw ?? "0");
        if (bal + pendingSum < required) {
          throw new Error(`Send at least ${nano(fundAmountRaw)} XNO to your shield address first`);
        }
        setStatusMessage("Receiving pending funds...");
        const received = await receivePending(required);
        if (!received) throw new Error("RECEIVE-PENDING: Could not receive funds in time. Try again.");
        // State captured by this closure is stale; fetch the updated balance/frontier directly.
        const freshInfo = await apiGet(`/api/account_info?account=${encodeURIComponent(source.address)}`);
        bal = BigInt(freshInfo.balance ?? "0");
        currentSourceInfo = {
          frontier: freshInfo.frontier ?? null,
          representative: freshInfo.representative ?? null,
        };
        setBalance(freshInfo.balance ?? "0");
        setSourceInfo(currentSourceInfo);
      }

      const poolData = await apiGet(`/api/pool_address/${effectiveDenom}`);
      const poolPubHex = poolData.pool_pubkey as string;
      const S_pub = hexToBytes(poolPubHex);
      const P_w = hexToBytes(withdraw.publicKey);
      const n = deriveSecretBytes(seed!, withdraw.publicKey, "vela/n");
      const t = deriveSecretBytes(seed!, withdraw.publicKey, "vela/t");
      const C = computeCommitment(n, t, P_w, S_pub);
      const C_hex = C.toString(16).padStart(64, "0");
      log(`Commitment: ${C_hex.slice(0, 16)}...`);

      if (!currentSourceInfo.frontier) {
        throw new Error("DEPOSIT-FRONTIER: Source account frontier is not available after receiving.");
      }
      setStatusMessage("Computing proof of work for deposit...");
      let depositWork = await generateWork(currentSourceInfo.frontier, "send");
      setStatusMessage("Broadcasting deposit block...");
      const depositBlock = buildSendBlock(source.secretKey, {
        fromAddress: source.address,
        previous: currentSourceInfo.frontier,
        representative: currentSourceInfo.representative || DEFAULT_REP,
        balance: (bal - denom).toString(),
        link: poolPubHex,
        amount: denom.toString(),
        work: depositWork,
      });
      const depositPrevious = String(depositBlock.block.previous);
      if (!validateWork(depositWork, depositPrevious, SEND_THRESHOLD)) {
        log(`WARN: Deposit work invalid; retrying`);
        depositWork = await generateWork(depositPrevious, "send");
        (depositBlock.block as Record<string, unknown>).work = depositWork;
        if (!validateWork(depositWork, depositPrevious, SEND_THRESHOLD)) {
          throw new Error("DEPOSIT-WORK: Generated work is invalid for deposit block");
        }
      }
      log(`Deposit hash: ${depositBlock.hash}`);
      await apiPost("/api/broadcast", { block: depositBlock.block, subtype: "send" });
      log("Deposit broadcasted");

      setStatusMessage("Computing proof of work for commitment...");
      let commitWork = await generateWork(depositBlock.hash, "send");
      setStatusMessage("Broadcasting commitment block...");
      const commitBlock = buildSendBlock(source.secretKey, {
        fromAddress: source.address,
        previous: depositBlock.hash,
        representative: currentSourceInfo.representative || DEFAULT_REP,
        balance: (bal - denom - BigInt(1)).toString(),
        link: C_hex,
        amount: "1",
        work: commitWork,
      });
      const commitPrevious = String(commitBlock.block.previous);
      if (!validateWork(commitWork, commitPrevious, SEND_THRESHOLD)) {
        log(`WARN: Commitment work invalid; retrying`);
        commitWork = await generateWork(commitPrevious, "send");
        (commitBlock.block as Record<string, unknown>).work = commitWork;
        if (!validateWork(commitWork, commitPrevious, SEND_THRESHOLD)) {
          throw new Error("COMMIT-WORK: Generated work is invalid for commitment block");
        }
      }
      log(`Commit hash: ${commitBlock.hash}`);
      await apiPost("/api/broadcast", { block: commitBlock.block, subtype: "send" });
      log("Commitment broadcasted");

      setStatusMessage("Waiting for deposit/commit confirmation...");
      const confirmed = await waitForConfirmation([depositBlock.hash, commitBlock.hash]);
      if (!confirmed) {
        throw new Error("DEPOSIT-CONFIRM: Deposit/commit blocks were not confirmed in time.");
      }

      await submitDepositWithRetry(depositBlock.hash, commitBlock.hash, setStatusMessage);
      log("Indexer accepted deposit.");
      setDepositTx({ depositHash: depositBlock.hash, commitHash: commitBlock.hash });
      setDepositDone(true);
      setStatusMessage("Waiting for your shield to be indexed...");
      startDepositStatusPolling(C_hex);
    } catch (err) {
      setStatusMessage(null);
      log(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  function startDepositStatusPolling(C_hex: string) {
    let attempts = 0;
    const maxAttempts = 60;
    const id = setInterval(async () => {
      attempts++;
      try {
        const status = (await apiGet(`/api/deposit_status?commitment=${C_hex}`)) as {
          indexed: boolean;
          leaf_index?: number;
        };
        if (status.indexed) {
          clearInterval(id);
          setWithdrawReady(true);
          setStatusMessage("Shield complete. You can send now.");
          log(`Shield indexed at leaf ${status.leaf_index ?? "?"}`);
        } else if (attempts >= maxAttempts) {
          clearInterval(id);
          setStatusMessage("Deposit indexing is taking longer than expected. You can retry later.");
        }
      } catch {
        // ignore polling errors
      }
    }, 5_000);
  }

  async function handleWithdraw() {
    if (!source || !withdraw || !epoch) return;
    setBusy(true);
    setStatusMessage("Generating zero-knowledge proof...");
    try {
      const n = deriveSecretBytes(seed!, withdraw.publicKey, "vela/n");
      const t = deriveSecretBytes(seed!, withdraw.publicKey, "vela/t");
      const nullifier = computeNullifier(n);
      log(`Withdrawing to: ${withdraw.address}`);

      const proofRes = await apiPost("/api/prove", {
        n: bytesToHex(n),
        t: bytesToHex(t),
        P_w: withdraw.publicKey,
        nullifier: nullifier.toString(16),
        denomination: String(effectiveDenom),
        epoch,
      });
      if (!proofRes.proof || !proofRes.publicSignals) throw new Error("WITHDRAW-PROOF: Proof response missing proof or publicSignals");
      log("Proof generated");

      setStatusMessage("Requesting guardian signature...");
      const withdrawRes = await apiPost("/api/withdraw", {
        destination: withdraw.address,
        epoch,
        denomination: String(effectiveDenom),
        nullifier: nullifier.toString(16),
        proof: proofRes.proof,
        publicSignals: proofRes.publicSignals,
      });
      if (!withdrawRes.block || !withdrawRes.block_hash) throw new Error("WITHDRAW-SIGN: Guardian did not return a block");

      // PoW must be computed on the pool frontier (the block's previous field), not the block hash.
      const workHash = typeof withdrawRes.block.previous === "string" ? withdrawRes.block.previous : withdrawRes.block_hash;
      setStatusMessage("Computing proof of work...");
      let work = await generateWork(workHash, "send");
      const signedBlock = { ...withdrawRes.block, work };
      const blockPrevious = String(signedBlock.previous);
      if (!validateWork(work, blockPrevious, SEND_THRESHOLD)) {
        log(`WARN: Withdraw work invalid; retrying`);
        work = await generateWork(blockPrevious, "send");
        signedBlock.work = work;
        if (!validateWork(work, blockPrevious, SEND_THRESHOLD)) {
          throw new Error("WITHDRAW-WORK: Generated work is invalid for withdraw block");
        }
      }
      const broadcastRes = (await apiPost("/api/broadcast_withdrawal", {
        nullifier: nullifier.toString(16),
        block: signedBlock,
      })) as { broadcast_result?: { hash?: string }; ok?: boolean };
      if (!broadcastRes.ok) throw new Error("WITHDRAW-BROADCAST: Guardian did not confirm broadcast");
      log(`Private send broadcasted to ${withdraw.address}`);
      setWithdrawTx(broadcastRes.broadcast_result?.hash ?? withdrawRes.block_hash);
      setLastWithdrawAddress(withdraw.address);
      setWithdrawIndex((i) => i + 1);
      setWithdrawReady(false);
      setDepositDone(false);
      setDepositTx(null);
      setStatusMessage("Private send complete.");
    } catch (err) {
      setStatusMessage(null);
      log(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  const fundAmountRaw = useMemo(
    () => BigInt(effectiveDenom) + WALLET_FRIENDLY_PADDING_RAW,
    [effectiveDenom]
  );
  const depositAmountText = useMemo(() => nano(fundAmountRaw), [fundAmountRaw]);

  const depositUri = useMemo(() => {
    if (!source) return "";
    // Nano URI amount must be in raw (integer) for wallet apps to auto-fill it.
    // Use a 6-decimal padding amount so wallets like Natrium don't round away
    // the required 1 raw commitment.
    return `nano:${source.address}?amount=${fundAmountRaw.toString()}`;
  }, [source, fundAmountRaw]);

  function HighlightedAmount({ amount }: { amount: string }) {
    if (!amount) return null;
    const last = amount.slice(-1);
    const rest = amount.slice(0, -1);
    return (
      <span className="font-mono font-semibold">
        {rest}
        <span className="font-extrabold text-black underline decoration-2 underline-offset-2">
          {last}
        </span>
        {" XNO"}
      </span>
    );
  }

  const inputClass =
    "w-full rounded-lg border border-black/20 bg-white px-4 py-2 text-black focus:border-black focus:outline-none";

  function stepClasses(step: number) {
    const isActive = activeStep === step;
    const isCompleted = completedStep >= step;
    return [
      "flex items-start gap-4 rounded-xl border bg-white p-5 transition-opacity",
      isActive || isCompleted ? "border-black/20" : "border-black/10 opacity-60",
    ].join(" ");
  }
  function stepNumClasses(step: number) {
    const isActive = activeStep === step;
    const isCompleted = completedStep >= step;
    return [
      "flex h-8 w-8 shrink-0 items-center justify-center rounded-full border text-sm font-semibold",
      isCompleted ? "border-black bg-black text-white" : isActive ? "border-black text-black" : "border-black/20 text-black/50",
    ].join(" ");
  }

  if (view === "create") {
    return (
      <div className="mx-auto max-w-md px-4 py-16">
        <h1 className="text-3xl font-bold">Create wallet</h1>
        <p className="mt-2 text-black/50">Set a password to encrypt your wallet in this browser.</p>
        {error && <p className="mt-4 text-black">{error}</p>}
        <div className="mt-6 space-y-4">
          <input type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} className={inputClass} />
          <input type="password" placeholder="Confirm password" value={passwordConfirm} onChange={(e) => setPasswordConfirm(e.target.value)} className={inputClass} />
          <Button onClick={handleCreate} className="w-full">Create encrypted wallet</Button>
          <button onClick={() => setView("restore")} className="w-full text-sm text-black/50 hover:text-black">Restore from phrase</button>
        </div>
      </div>
    );
  }

  if (view === "restore") {
    return (
      <div className="mx-auto max-w-md px-4 py-16">
        <h1 className="text-3xl font-bold">Restore wallet</h1>
        <p className="mt-2 text-black/50">Enter your 24-word recovery phrase.</p>
        {error && <p className="mt-4 text-black">{error}</p>}
        <div className="mt-6 space-y-4">
          <textarea value={phrase} onChange={(e) => setPhrase(e.target.value)} placeholder="abandon abandon ability ..." rows={4} className={inputClass} />
          <input type="password" placeholder="New password" value={password} onChange={(e) => setPassword(e.target.value)} className={inputClass} />
          <Button onClick={handleRestore} className="w-full">Restore</Button>
          <button onClick={() => setView("create")} className="w-full text-sm text-black/50 hover:text-black">Create new wallet</button>
        </div>
      </div>
    );
  }

  if (view === "locked") {
    return (
      <div className="mx-auto max-w-md px-4 py-16">
        <h1 className="text-3xl font-bold">Unlock wallet</h1>
        {error && <p className="mt-4 text-black">{error}</p>}
        <div className="mt-6 space-y-4">
          <input type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} className={inputClass} />
          <Button onClick={handleUnlock} className="w-full">Unlock</Button>
          <button onClick={() => setView("restore")} className="w-full text-sm text-black/50 hover:text-black">Restore from phrase</button>
        </div>
      </div>
    );
  }

  const totalAvailable = (BigInt(balance ?? "0") + BigInt(pendingRaw ?? "0")).toString();
  const hasFunds = Boolean(BigInt(totalAvailable) >= BigInt(effectiveDenom) + BigInt(1));
  const hasPending = Boolean(pendingRaw && BigInt(pendingRaw) > 0);

  let activeStep = 1;
  if (hasFunds || depositDone) activeStep = 2;
  if (withdrawReady) activeStep = 3;
  if (busy) activeStep = 0;

  let completedStep = 0;
  if (hasFunds) completedStep = 1;
  if (depositDone) completedStep = 2;
  if (withdrawTx) completedStep = 3;

  return (
    <div className="mx-auto max-w-2xl px-4 py-12">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold sm:text-3xl">Send XNO Privately</h1>
          <p className="mt-2 text-black/50">Fund, shield, and send XNO without linking sender and receiver.</p>
        </div>
        <Button variant="ghost" onClick={lock} className="shrink-0">Lock Page</Button>
      </div>

      <div className="mt-6 flex items-center justify-between">
        <label className="text-sm font-medium text-black/70">Amount</label>
        <select
          value={effectiveDenom}
          onChange={(e) => {
            setDenomManuallyChanged(true);
            setDenomRaw(e.target.value);
          }}
          className="rounded-lg border border-black/20 bg-white px-3 py-1 text-sm text-black focus:border-black focus:outline-none"
        >
          {DENOMINATIONS.map((d) => (
            <option key={d.raw} value={d.raw}>{d.label}</option>
          ))}
        </select>
      </div>

      {statusMessage && (
        <div className="mt-4 rounded-lg border border-black/10 bg-black/5 px-4 py-3 text-sm text-black">
          {busy && <span className="mr-2 inline-block h-3 w-3 animate-spin rounded-full border border-black/30 border-t-black" />}
          {statusMessage}
        </div>
      )}

      {greenlight === null && (
        <div className="mt-4 rounded-lg border border-black/10 bg-black/5 px-4 py-3 text-sm text-black">
          <span className="mr-2 inline-block h-3 w-3 animate-spin rounded-full border border-black/30 border-t-black" />
          Checking network and backend health...
        </div>
      )}

      {greenlight?.ok === false && (
        <div className="mt-4 rounded-lg border border-black/10 bg-black/5 px-4 py-3 text-sm text-black">
          <span className="font-semibold">Network not ready:</span> {greenlight.error}
          <button
            onClick={() => {
              setGreenlight(null);
              apiGet("/api/greenlight")
                .then(() => setGreenlight({ ok: true }))
                .catch((err) => setGreenlight({ ok: false, error: err instanceof Error ? err.message : "Network check failed" }));
            }}
            className="ml-3 rounded-lg border border-black/20 px-3 py-1 text-xs hover:bg-black/5"
          >
            Retry
          </button>
        </div>
      )}

      {greenlight?.ok && epoch && (
        <div className="mt-4 flex items-center justify-between rounded-lg border border-black/10 bg-black/5 px-4 py-2 text-xs text-black/70">
          <span>Epoch <span className="font-mono font-semibold text-black">{epoch}</span></span>
          <span className="text-black/50">Pool ready</span>
        </div>
      )}

      <div className="mt-6 space-y-4">
        <div className={stepClasses(1)}>
          <div className={stepNumClasses(1)}>1</div>
          <div className="flex-1">
            <h2 className="font-semibold">Fund your shield address</h2>
            <p className="text-sm text-black/50">
              Send exactly <HighlightedAmount amount={depositAmountText} /> to this temporary address.
            </p>
            <p className="text-xs text-black/50">
              The QR amount includes a tiny buffer so mobile wallets display it correctly.
              The shield only uses {nano(BigInt(effectiveDenom))} XNO + 1 raw; the rest stays as dust in this address.
            </p>
            {greenlight?.ok && source && (
              <div className="mt-4">
                <div className="flex items-center gap-2">
                  <code className="break-all rounded-lg border border-black/10 bg-black/5 px-3 py-2 text-xs font-mono">{source.address}</code>
                  <CopyButton text={source.address} />
                </div>
                <div className="mt-4 inline-block rounded-lg border border-black/10 bg-white p-4">
                  {depositUri && <QRCodeSVG value={depositUri} size={160} />}
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <a href={depositUri} className="rounded-lg border border-black/20 px-3 py-2 text-sm hover:bg-black/5">Open in wallet</a>
                </div>
                <p className="mt-2 text-xs text-black/50">
                  Available: {balance ? `${nano(BigInt(balance))} XNO` : "—"}
                  {hasPending && ` · Pending: ${nano(BigInt(pendingRaw ?? "0"))} XNO`}
                </p>
              </div>
            )}
            {greenlight?.ok === false && (
              <p className="mt-4 text-sm text-black/70">The deposit address is hidden until the network check passes.</p>
            )}
          </div>
        </div>

        <div className={stepClasses(2)}>
          <div className={stepNumClasses(2)}>2</div>
          <div className="flex-1">
            <h2 className="font-semibold">Shield into the pool</h2>
            <p className="text-sm text-black/50">Move {nano(BigInt(effectiveDenom))} XNO + 1 raw into the privacy pool.</p>
            {hasPending && !depositDone && (
              <p className="mt-2 text-sm text-black/70">Funding detected — you can shield now.</p>
            )}
            <Button onClick={handleDeposit} disabled={busy || !greenlight?.ok || !hasFunds || depositDone} className="mt-4 w-full">
              {busy ? "Working..." : depositDone ? "Shielded" : "Shield now"}
            </Button>
            {depositTx && (
              <div className="mt-3 flex flex-wrap gap-3 text-xs text-black/70">
                <a href={explorerLink(depositTx.depositHash)} target="_blank" rel="noreferrer" className="underline">Deposit tx</a>
                <a href={explorerLink(depositTx.commitHash)} target="_blank" rel="noreferrer" className="underline">Commit tx</a>
              </div>
            )}
          </div>
        </div>

        <div className={stepClasses(3)}>
          <div className={stepNumClasses(3)}>3</div>
          <div className="flex-1">
            <h2 className="font-semibold">Send to a fresh address</h2>
            <p className="text-sm text-black/50">
              Recipient receives {nano(BigInt(effectiveDenom) - withdrawFeeRaw(BigInt(effectiveDenom), feeBps))} XNO
              {feeBps > 0 ? `(${(feeBps / 100).toFixed(1)}% guardian fee deducted)` : "(no guardian fee)"}.
            </p>
            <Button onClick={handleWithdraw} disabled={busy || !withdrawReady} variant="secondary" className="mt-4 w-full">
              {busy ? "Working..." : "Withdraw now"}
            </Button>
            {withdrawTx && (
              <div className="mt-3 text-xs text-black/70">
                <a href={explorerLink(withdrawTx)} target="_blank" rel="noreferrer" className="underline">Withdrawal tx</a>
              </div>
            )}
            {lastWithdrawAddress && (
              <p className="mt-3 text-sm text-black/70">
                Last withdrawal: <span className="font-mono">{lastWithdrawAddress}</span>
              </p>
            )}
          </div>
        </div>
      </div>

      {phrase && (
        <div className="mt-8 rounded-xl border border-black/10 bg-black/5 p-5">
          <h3 className="font-semibold">Recovery phrase</h3>
          <p className="mt-1 text-sm text-black/60">Save these 24 words. They are the only way to recover this wallet.</p>
          <p className="mt-3 break-words font-mono text-sm text-black">{phrase}</p>
        </div>
      )}

      {logs.length > 0 && (
        <div className="mt-8 rounded-xl border border-black/10 bg-black/5 p-5">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-black/70">Activity log</h2>
          <pre className="max-h-64 overflow-auto font-mono text-xs text-black/70">
            {logs.join("\n")}
          </pre>
        </div>
      )}
    </div>
  );
}
