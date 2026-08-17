"use client";

import "@/lib/polyfills";
import { useCallback, useEffect, useMemo, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import {
  deriveLegacyAccount,
  buildSendBlock,
  buildReceiveBlock,
  rawToNano,
  publicKeyToAddress,
  nanoToRaw,
  validateWork,
  isValidAddress,
} from "@/lib/wallet";
import { encryptSeed, decryptSeed } from "@/lib/crypto-storage";
import { createBackupPhrase, phraseToSeedHex } from "@/lib/mnemonic";
import { computeCommitment, computeNullifier, hexToBytes, bytesToHex } from "@/lib/vela-crypto";
import { generateLocalWork } from "@/lib/client-work";
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

  // Race the server work service (pre-warmed cache / on-demand compute)
  // against device generation (WebGPU/WebGL2/WASM in a worker). Whichever
  // produces valid work first wins — a warm server cache returns in <1s,
  // while a cold cache lets a fast GPU finish long before the server.
  const DEADLINE_MS = 180_000;

  const serverAttempt = (async (): Promise<string | null> => {
    const deadline = Date.now() + DEADLINE_MS;
    while (Date.now() < deadline) {
      try {
        const res = await apiPost("/api/work", { hash, difficulty });
        if (res.work && validateWork(res.work, hash, difficulty)) return res.work;
      } catch {
        // Not ready yet — the request also queued background computation.
      }
      await new Promise((r) => setTimeout(r, 4000));
    }
    return null;
  })();

  const deviceAttempt = generateLocalWork(hash, difficulty, DEADLINE_MS);

  const work = await new Promise<string | null>((resolve) => {
    let unresolved = 2;
    const settle = (w: string | null) => {
      if (w) resolve(w);
      else if (--unresolved === 0) resolve(null);
    };
    serverAttempt.then(settle, () => settle(null));
    deviceAttempt.then(settle, () => settle(null));
  });

  if (!work) throw new Error("Work generation failed on both server and device");
  return work;
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
  const [externalAddress, setExternalAddress] = useState("");
  const [activeAction, setActiveAction] = useState<"deposit" | "withdraw" | "external" | null>(null);
  const [externalAvailable, setExternalAvailable] = useState<bigint | null>(null);
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

  // Precompute upcoming proof-of-work in the background while the user reads
  // the UI: the deposit block's work root is the current frontier, and the
  // first receive's root is the account public key.
  useEffect(() => {
    if (!source || depositDone) return;
    if (sourceInfo?.frontier) warmWork(sourceInfo.frontier, "send");
    else warmWork(source.publicKey, "receive");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source?.publicKey, sourceInfo?.frontier, depositDone]);

  // Recover shield state after a page reload: if this wallet's commitment is
  // already indexed and its nullifier is unspent, withdrawing is possible
  // right away — the in-memory depositDone/withdrawReady flags don't survive
  // a refresh.
  useEffect(() => {
    if (!seed || !withdraw || withdrawReady || busy) return;
    let alive = true;
    (async () => {
      try {
        const poolData = await apiGet(`/api/pool_address/${effectiveDenom}`);
        const S_pub = hexToBytes(poolData.pool_pubkey as string);
        const P_w = hexToBytes(withdraw.publicKey);
        const n = deriveSecretBytes(seed, withdraw.publicKey, "vela/n");
        const t = deriveSecretBytes(seed, withdraw.publicKey, "vela/t");
        const C_hex = computeCommitment(n, t, P_w, S_pub).toString(16).padStart(64, "0");
        const status = (await apiGet(`/api/deposit_status?commitment=${C_hex}`)) as {
          indexed?: boolean;
          epoch?: number;
        };
        if (!alive || !status.indexed) return;
        const nullifier = computeNullifier(n);
        const nullStatus = await apiGet(
          `/api/nullifier_status?nullifier=${nullifier.toString(16)}`
        ).catch(() => null);
        if (!alive || nullStatus?.spent) return;
        if (typeof status.epoch === "number") setEpoch(status.epoch);
        setDepositDone(true);
        setWithdrawReady(true);
        setStatusMessage("Existing shield found. You can send privately now.");
        log("Recovered existing shield from indexer.");
      } catch {
        // Recovery is best-effort; the normal deposit flow still works.
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed, withdraw, effectiveDenom, withdrawReady, busy]);

  function log(msg: string) {
    setLogs((prev) => [...prev, `${new Date().toLocaleTimeString()} ${msg}`]);
  }

  // Fire-and-forget background work precomputation. nano-pow caches results
  // per hash, so warming a root early makes the real request near-instant —
  // the main mobile speedup, since slow devices otherwise stall at each step.
  function warmWork(hash: string | null | undefined, subtype: "send" | "receive") {
    if (!hash || !/^[0-9a-fA-F]{64}$/.test(hash)) return;
    const difficulty = subtype === "send" ? SEND_THRESHOLD : RECEIVE_THRESHOLD;
    void generateLocalWork(hash, difficulty, 300_000);
  }

  // Proof-of-work can take from seconds (GPU) to minutes (WASM). Show a live
  // elapsed-seconds timer in the status banner so waiting never looks stuck.
  async function generateWorkTimed(hash: string, subtype: "send" | "receive"): Promise<string> {
    const label = subtype === "send" ? "Computing proof of work (send)" : "Computing proof of work (receive)";
    const start = Date.now();
    setStatusMessage(`${label}... 0s`);
    const id = setInterval(() => {
      const s = Math.floor((Date.now() - start) / 1000);
      setStatusMessage(`${label}... ${s}s${s >= 45 ? " — still working, GPU may be slow on this device" : ""}`);
    }, 1000);
    try {
      const work = await generateWork(hash, subtype);
      const total = ((Date.now() - start) / 1000).toFixed(1);
      log(`Proof of work (${subtype}) ready in ${total}s`);
      return work;
    } finally {
      clearInterval(id);
    }
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
    let work = await generateWorkTimed(workHash, "receive");
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

    // Validate the work against the root used for generation (public key for open blocks, previous otherwise).
    if (!validateWork(work, workHash, RECEIVE_THRESHOLD)) {
      log(`WARN: Work invalid for receive root; retrying work generation`);
      work = await generateWorkTimed(workHash, "receive");
      (receiveBlock.block as Record<string, unknown>).work = work;
      if (!validateWork(work, workHash, RECEIVE_THRESHOLD)) {
        throw new Error("RECEIVE-WORK: Generated work is invalid for receive block");
      }
    }

    log(`Receive hash: ${receiveBlock.hash}`);
    log(`Receive work hash: ${workHash}, block previous: ${previous}, isOpen: ${isOpen}`);
    await apiPost("/api/broadcast", { block: receiveBlock.block, subtype: "receive" });
    log("Receive broadcasted");

    return waitForBalance(newBalance);
  }

  // Withdraw accounts only (index >= 1): funds here arrived via private
  // withdrawals and are not linkable to the public shield address. The shield
  // address (index 0) is deliberately excluded from external sweeps — shield
  // and withdraw those funds first to break the on-chain link.
  function privateAccounts() {
    if (!seed) return [];
    const maxIndex = Math.max(withdrawIndex + 2, 5);
    const accounts = [];
    for (let i = 1; i <= maxIndex; i++) accounts.push(deriveLegacyAccount(seed, i));
    return accounts;
  }

  // Total spendable (balance + receivable) across the private withdraw
  // accounts, so the user can see what an external send would move.
  useEffect(() => {
    if (!seed || view !== "dashboard") return;
    let alive = true;
    async function scan() {
      let total = BigInt(0);
      for (const acct of privateAccounts()) {
        try {
          const [info, pending] = await Promise.all([
            apiGet(`/api/account_info?account=${encodeURIComponent(acct.address)}`).catch(() => null),
            apiGet(`/api/pending?account=${encodeURIComponent(acct.address)}`).catch(() => ({ blocks: {} })),
          ]);
          total += BigInt(info?.balance ?? "0");
          for (const block of Object.values((pending?.blocks ?? {}) as Record<string, { amount: string }>)) {
            total += BigInt(block.amount ?? "0");
          }
        } catch {
          // skip unreachable accounts
        }
      }
      if (alive) setExternalAvailable(total);
    }
    scan();
    const id = setInterval(scan, 15_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed, view, withdrawIndex]);

  async function handleExternalSend() {
    const destination = externalAddress.trim();
    if (!isValidAddress(destination)) {
      log("ERROR: Invalid destination address");
      return;
    }
    setBusy(true);
    setActiveAction("external");
    setStatusMessage("Sending to external address...");
    try {
      let totalSent = BigInt(0);
      for (const acct of privateAccounts()) {
        // Receive anything pending on this account first.
        const pending = await apiGet(`/api/pending?account=${encodeURIComponent(acct.address)}`).catch(() => ({ blocks: {} }));
        const pendingEntries = Object.entries((pending?.blocks ?? {}) as Record<string, { amount: string }>);
        for (const [sendHash, block] of pendingEntries) {
          const info = await apiGet(`/api/account_info?account=${encodeURIComponent(acct.address)}`).catch(() => null);
          const previous = info?.frontier ?? ZERO_HASH;
          const isOpen = previous === ZERO_HASH;
          const workHash = workHashForReceive(previous, acct.publicKey);
          const work = await generateWorkTimed(workHash, "receive");
          const receiveBlock = buildReceiveBlock(acct.secretKey, {
            toAddress: acct.address,
            previous,
            representative: info?.representative ?? DEFAULT_REP,
            transactionHash: sendHash,
            balance: isOpen ? "0" : String(info?.balance ?? "0"),
            amount: String(block.amount ?? "0"),
            work,
          });
          await apiPost("/api/broadcast", { block: receiveBlock.block, subtype: "receive" });
          log(`Received pending on account ${acct.index}: ${receiveBlock.hash.slice(0, 16)}...`);
        }

        const info = await apiGet(`/api/account_info?account=${encodeURIComponent(acct.address)}`).catch(() => null);
        const balance = BigInt(info?.balance ?? "0");
        if (!info?.frontier || balance <= BigInt(0)) continue;

        const work = await generateWorkTimed(info.frontier, "send");
        const sendBlock = buildSendBlock(acct.secretKey, {
          fromAddress: acct.address,
          previous: info.frontier,
          representative: info.representative || DEFAULT_REP,
          balance: "0",
          link: destination,
          amount: balance.toString(),
          work,
        });
        await apiPost("/api/broadcast", { block: sendBlock.block, subtype: "send" });
        totalSent += balance;
        log(`Sent ${nano(balance)} XNO from account ${acct.index}: ${sendBlock.hash}`);
      }
      if (totalSent === BigInt(0)) {
        log("No spendable funds found to send.");
        setStatusMessage(null);
      } else {
        log(`Total sent to ${destination}: ${nano(totalSent)} XNO`);
        setStatusMessage(`Sent ${nano(totalSent)} XNO. It will appear at the destination shortly.`);
      }
    } catch (err) {
      setStatusMessage(null);
      log(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
      setActiveAction(null);
    }
  }

  async function handleDeposit() {
    if (!source || !withdraw || !sourceInfo) return;
    setBusy(true);
    setActiveAction("deposit");
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

      // A (source, withdraw key) pair maps to one nullifier forever. If it was
      // already spent, a new deposit could never be withdrawn — refuse now,
      // before any funds move.
      const nullifierCheck = computeNullifier(n);
      const nullStatus = await apiGet(
        `/api/nullifier_status?nullifier=${nullifierCheck.toString(16)}`
      ).catch(() => null);
      if (nullStatus?.spent) {
        throw new Error(
          `This shield/withdraw pair was already used (nullifier spent). Switch to a fresh withdraw account (index ${withdrawIndex + 1}) before depositing.`
        );
      }

      // If this commitment is already indexed, a second identical deposit
      // would be deduplicated and its funds unrecoverable — skip straight to
      // the withdraw step instead.
      const existing = (await apiGet(`/api/deposit_status?commitment=${C_hex}`).catch(() => null)) as {
        indexed?: boolean;
        epoch?: number;
      } | null;
      if (existing?.indexed) {
        log("Shield already indexed for this wallet; skipping duplicate deposit.");
        if (typeof existing.epoch === "number") setEpoch(existing.epoch);
        setDepositDone(true);
        setWithdrawReady(true);
        setStatusMessage("Shield already active. You can send now.");
        return;
      }

      if (!currentSourceInfo.frontier) {
        throw new Error("DEPOSIT-FRONTIER: Source account frontier is not available after receiving.");
      }
      setStatusMessage("Computing proof of work for deposit...");
      let depositWork = await generateWorkTimed(currentSourceInfo.frontier, "send");
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
        depositWork = await generateWorkTimed(depositPrevious, "send");
        (depositBlock.block as Record<string, unknown>).work = depositWork;
        if (!validateWork(depositWork, depositPrevious, SEND_THRESHOLD)) {
          throw new Error("DEPOSIT-WORK: Generated work is invalid for deposit block");
        }
      }
      log(`Deposit hash: ${depositBlock.hash}`);
      // The commit block's work root is the deposit hash — start computing it
      // in the background so it is ready by the time the broadcast returns.
      warmWork(depositBlock.hash, "send");
      await apiPost("/api/broadcast", { block: depositBlock.block, subtype: "send" });
      log("Deposit broadcasted");

      setStatusMessage("Computing proof of work for commitment...");
      let commitWork = await generateWorkTimed(depositBlock.hash, "send");
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
        commitWork = await generateWorkTimed(commitPrevious, "send");
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
      setActiveAction(null);
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
    setActiveAction("withdraw");
    setStatusMessage("Generating zero-knowledge proof...");
    // The withdrawal block's work root is the pool frontier — warm it while
    // the proof generates so the work step is near-instant.
    void (async () => {
      try {
        const poolData = await apiGet(`/api/pool_address/${effectiveDenom}`);
        const poolAddr = publicKeyToAddress(String(poolData.pool_pubkey));
        const info = await apiGet(`/api/account_info?account=${encodeURIComponent(poolAddr)}`);
        warmWork(info.frontier, "send");
      } catch {
        // best-effort warm-up only
      }
    })();
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
      // The pool frontier can move between signing and broadcast (the guardian
      // sweeps incoming deposits). On a Fork rejection, re-request the
      // withdrawal — the guardian re-signs against the current frontier.
      let broadcastRes: { broadcast_result?: { hash?: string }; ok?: boolean } | null = null;
      let lastBlockHash = "";
      for (let attempt = 1; attempt <= 3; attempt++) {
        const withdrawRes = await apiPost("/api/withdraw", {
          destination: withdraw.address,
          epoch,
          denomination: String(effectiveDenom),
          nullifier: nullifier.toString(16),
          proof: proofRes.proof,
          publicSignals: proofRes.publicSignals,
        });
        if (!withdrawRes.block || !withdrawRes.block_hash) throw new Error("WITHDRAW-SIGN: Guardian did not return a block");
        lastBlockHash = withdrawRes.block_hash;

        // PoW must be computed on the pool frontier (the block's previous field), not the block hash.
        const blockPrevious = String(withdrawRes.block.previous);
        setStatusMessage("Computing proof of work...");
        let work = await generateWorkTimed(blockPrevious, "send");
        const signedBlock = { ...withdrawRes.block, work };
        if (!validateWork(work, blockPrevious, SEND_THRESHOLD)) {
          log(`WARN: Withdraw work invalid; retrying`);
          work = await generateWorkTimed(blockPrevious, "send");
          signedBlock.work = work;
          if (!validateWork(work, blockPrevious, SEND_THRESHOLD)) {
            throw new Error("WITHDRAW-WORK: Generated work is invalid for withdraw block");
          }
        }
        try {
          broadcastRes = (await apiPost("/api/broadcast_withdrawal", {
            nullifier: nullifier.toString(16),
            block: signedBlock,
          })) as { broadcast_result?: { hash?: string }; ok?: boolean };
          break;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (attempt < 3 && /fork|gap previous/i.test(msg)) {
            log(`Pool frontier moved during proof of work; re-signing (attempt ${attempt + 1}/3)...`);
            continue;
          }
          throw err;
        }
      }
      if (!broadcastRes?.ok) throw new Error("WITHDRAW-BROADCAST: Guardian did not confirm broadcast");
      log(`Private send broadcasted to ${withdraw.address}`);
      setWithdrawTx(broadcastRes.broadcast_result?.hash ?? lastBlockHash);
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
      setActiveAction(null);
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
      "flex items-start gap-3 rounded-xl border bg-white p-4 transition-opacity sm:gap-4 sm:p-5",
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

      {statusMessage && !activeAction && (
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
          <div className="min-w-0 flex-1">
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
                  <code className="min-w-0 flex-1 break-all rounded-lg border border-black/10 bg-black/5 px-3 py-2 font-mono text-xs">{source.address}</code>
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
          <div className="min-w-0 flex-1">
            <h2 className="font-semibold">Shield into the pool</h2>
            <p className="text-sm text-black/50">Move {nano(BigInt(effectiveDenom))} XNO + 1 raw into the privacy pool.</p>
            {hasPending && !depositDone && (
              <p className="mt-2 text-sm text-black/70">Funding detected — you can shield now.</p>
            )}
            <Button onClick={handleDeposit} disabled={busy || !greenlight?.ok || !hasFunds || depositDone} className="mt-4 w-full">
              {busy ? "Working..." : depositDone ? "Shielded" : "Shield now"}
            </Button>
            {statusMessage && activeAction === "deposit" && (
              <div className="mt-3 rounded-lg border border-black/10 bg-black/5 px-4 py-3 text-sm text-black">
                <span className="mr-2 inline-block h-3 w-3 animate-spin rounded-full border border-black/30 border-t-black" />
                {statusMessage}
              </div>
            )}
            {depositTx && (
              <div className="mt-3 flex flex-wrap gap-3 text-xs text-black/70">
                <a href={explorerLink(depositTx.depositHash)} target="_blank" rel="noreferrer" className="underline">Deposit tx</a>
                <a href={explorerLink(depositTx.commitHash)} target="_blank" rel="noreferrer" className="underline">Commit tx</a>
              </div>
            )}
          </div>
        </div>

        {logs.length > 0 && (
          <div className="rounded-xl border border-black/10 bg-black/5 p-5">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-black/70">Activity log</h2>
            <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap break-all font-mono text-xs text-black/70">
              {[...logs].reverse().join("\n")}
            </pre>
          </div>
        )}

        <div className={stepClasses(3)}>
          <div className={stepNumClasses(3)}>3</div>
          <div className="min-w-0 flex-1">
            <h2 className="font-semibold">Send to a fresh address</h2>
            <p className="text-sm text-black/50">
              Recipient receives {nano(BigInt(effectiveDenom) - withdrawFeeRaw(BigInt(effectiveDenom), feeBps))} XNO
              {feeBps > 0 ? `(${(feeBps / 100).toFixed(1)}% guardian fee deducted)` : "(no guardian fee)"}.
            </p>
            <Button onClick={handleWithdraw} disabled={busy || !withdrawReady} variant="secondary" className="mt-4 w-full">
              {busy ? "Working..." : "Withdraw now"}
            </Button>
            {statusMessage && activeAction === "withdraw" && (
              <div className="mt-3 rounded-lg border border-black/10 bg-black/5 px-4 py-3 text-sm text-black">
                <span className="mr-2 inline-block h-3 w-3 animate-spin rounded-full border border-black/30 border-t-black" />
                {statusMessage}
              </div>
            )}
            {withdrawTx && (
              <div className="mt-3 text-xs text-black/70">
                <a href={explorerLink(withdrawTx)} target="_blank" rel="noreferrer" className="underline">Withdrawal tx</a>
              </div>
            )}
            {lastWithdrawAddress && (
              <p className="mt-3 text-sm text-black/70">
                Last withdrawal: <span className="break-all font-mono">{lastWithdrawAddress}</span>
              </p>
            )}
          </div>
        </div>
      </div>

      <div className="mt-8 rounded-xl border border-black/10 bg-black/5 p-5">
        <h2 className="font-semibold">Send to exchange or external wallet</h2>
        <p className="mt-1 text-sm text-black/60">
          Sweeps your private (withdrawn) funds to any Nano address — e.g. your Binance
          XNO deposit address. Your public shield address is never included, so the
          destination cannot be linked to your deposits.
        </p>
        <p className="mt-2 text-sm text-black/70">
          Private funds available: {externalAvailable === null ? "..." : `${nano(externalAvailable)} XNO`}
        </p>
        {BigInt(balance ?? "0") + BigInt(pendingRaw ?? "0") > BigInt(0) && (
          <p className="mt-1 text-xs text-black/50">
            Your shield address still holds {nano(BigInt(balance ?? "0") + BigInt(pendingRaw ?? "0"))} XNO.
            To move it privately, shield and withdraw it first — it will then appear here as private funds.
          </p>
        )}
        <input
          type="text"
          placeholder="nano_... destination address"
          value={externalAddress}
          onChange={(e) => setExternalAddress(e.target.value)}
          className={`${inputClass} mt-3 font-mono`}
        />
        {externalAddress.trim() !== "" && !isValidAddress(externalAddress) && (
          <p className="mt-1 text-xs text-red-600">Not a valid Nano address</p>
        )}
        <Button
          onClick={handleExternalSend}
          disabled={busy || !isValidAddress(externalAddress) || !externalAvailable || externalAvailable === BigInt(0)}
          className="mt-3 w-full"
        >
          {busy ? "Working..." : "Send all to this address"}
        </Button>
        {statusMessage && activeAction === "external" && (
          <div className="mt-3 rounded-lg border border-black/10 bg-black/5 px-4 py-3 text-sm text-black">
            <span className="mr-2 inline-block h-3 w-3 animate-spin rounded-full border border-black/30 border-t-black" />
            {statusMessage}
          </div>
        )}
      </div>

      {phrase && (
        <div className="mt-8 rounded-xl border border-black/10 bg-black/5 p-5">
          <h3 className="font-semibold">Recovery phrase</h3>
          <p className="mt-1 text-sm text-black/60">Save these 24 words. They are the only way to recover this wallet.</p>
          <p className="mt-3 break-words font-mono text-sm text-black">{phrase}</p>
        </div>
      )}

    </div>
  );
}
