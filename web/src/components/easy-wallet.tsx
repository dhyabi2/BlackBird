"use client";

import "@/lib/polyfills";
import { useCallback, useEffect, useMemo, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { deriveLegacyAccount, buildSendBlock, buildReceiveBlock } from "@/lib/wallet";
import { encryptSeed, decryptSeed } from "@/lib/crypto-storage";
import { createBackupPhrase, phraseToSeedHex } from "@/lib/mnemonic";
import { computeCommitment, computeNullifier, hexToBytes, bytesToHex } from "@/lib/vela-crypto";
import { blake2b } from "blakejs";
import { convert, Unit } from "nanocurrency";
import { Button } from "@/components/ui/Button";
import { useNanoWebsocket } from "@/lib/nano-ws";

const STORAGE_KEY = "vela_wallet_v1";
const SESSION_SEED_KEY = "vela_session_seed";
const ZERO_HASH = "0000000000000000000000000000000000000000000000000000000000000000";
const DEFAULT_REP = "nano_3jwrszth46rk1mu7rmb4rhm54us8yg1gw3ipodftqtikf5yqdyr7471nsg1k";

const DENOMINATIONS = [
  { raw: "100000000000000000000000000000", label: "0.1 XNO" },
  { raw: "1000000000000000000000000000000", label: "1 XNO" },
  { raw: "10000000000000000000000000000000", label: "10 XNO" },
  { raw: "100000000000000000000000000000000", label: "100 XNO" },
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

function rawToNano(raw: string): string {
  return convert(raw, { from: Unit.raw, to: Unit.NANO });
}

function nano(raw: bigint): string {
  return rawToNano(raw.toString());
}

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
  if (!res.ok) throw new Error(data.error || `Request failed: ${res.status}`);
  return data;
}

async function apiGet(path: string) {
  const res = await fetch(path);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Request failed: ${res.status}`);
  return data;
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
  const [seed, setSeed] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    return sessionStorage.getItem(SESSION_SEED_KEY);
  });
  const [stored, setStored] = useState<string | null>(() =>
    typeof window !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null
  );
  const [view, setView] = useState<"locked" | "create" | "restore" | "dashboard">(() => {
    if (typeof window === "undefined") return "create";
    if (sessionStorage.getItem(SESSION_SEED_KEY)) return "dashboard";
    if (localStorage.getItem(STORAGE_KEY)) return "locked";
    return "create";
  });
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
    const workHash = isOpen ? source.publicKey : sourceInfo.frontier!;
    const work = (await apiPost("/api/work", { hash: workHash, difficulty: "fffffff800000000" })).work;
    const newBalance = (currentBalance + chosenAmount).toString();

    const receiveBlock = buildReceiveBlock(source.secretKey, {
      previous: isOpen ? ZERO_HASH : sourceInfo.frontier!,
      representative,
      balance: newBalance,
      link: chosenHash,
      work,
    });
    log(`Receive hash: ${receiveBlock.hash}`);
    await apiPost("/api/broadcast", { block: receiveBlock.block });
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
      if (bal < required) {
        const pendingSum = BigInt(pendingRaw ?? "0");
        if (bal + pendingSum < required) {
          throw new Error(`Send at least ${nano(required)} XNO to your source address first`);
        }
        setStatusMessage("Receiving pending funds...");
        const received = await receivePending(required);
        if (!received) throw new Error("Could not receive funds in time. Try again.");
        bal = BigInt(balance ?? "0");
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

      setStatusMessage("Broadcasting deposit block...");
      const depositBlock = buildSendBlock(source.secretKey, {
        previous: sourceInfo.frontier!,
        representative: sourceInfo.representative!,
        balance: (bal - denom).toString(),
        link: poolPubHex,
        work: (await apiPost("/api/work", { hash: sourceInfo.frontier!, difficulty: "fffffff800000000" })).work,
      });
      log(`Deposit hash: ${depositBlock.hash}`);
      await apiPost("/api/broadcast", { block: depositBlock.block });
      log("Deposit broadcasted");

      setStatusMessage("Broadcasting commitment block...");
      const commitBlock = buildSendBlock(source.secretKey, {
        previous: depositBlock.hash,
        representative: sourceInfo.representative!,
        balance: (bal - denom - BigInt(1)).toString(),
        link: C_hex,
        work: (await apiPost("/api/work", { hash: depositBlock.hash, difficulty: "fffffff800000000" })).work,
      });
      log(`Commit hash: ${commitBlock.hash}`);
      await apiPost("/api/broadcast", { block: commitBlock.block });
      log("Commitment broadcasted");

      await apiPost("/api/deposit", {
        deposit_hash: depositBlock.hash,
        commit_hash: commitBlock.hash,
      });
      log("Indexer accepted deposit.");
      setDepositTx({ depositHash: depositBlock.hash, commitHash: commitBlock.hash });
      setDepositDone(true);
      setStatusMessage("Waiting for the deposit to be indexed...");
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
          setStatusMessage("Deposit indexed. You can withdraw now.");
          log(`Deposit indexed at leaf ${status.leaf_index ?? "?"}`);
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
      if (!proofRes.proof || !proofRes.publicSignals) throw new Error("Proof failed");
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
      if (!withdrawRes.block || !withdrawRes.block_hash) throw new Error("Guardian did not return a block");

      // PoW must be computed on the pool frontier (the block's previous field), not the block hash.
      const workHash = typeof withdrawRes.block.previous === "string" ? withdrawRes.block.previous : withdrawRes.block_hash;
      setStatusMessage("Computing proof of work...");
      const work = (await apiPost("/api/work", { hash: workHash, difficulty: "fffffff800000000" })).work;
      const broadcastRes = (await apiPost("/api/broadcast", { block: { ...withdrawRes.block, work } })) as { hash?: string };
      log(`Withdrawal broadcasted to ${withdraw.address}`);
      setWithdrawTx(broadcastRes.hash ?? withdrawRes.block_hash);
      setLastWithdrawAddress(withdraw.address);
      setWithdrawIndex((i) => i + 1);
      setWithdrawReady(false);
      setDepositDone(false);
      setDepositTx(null);
      setStatusMessage("Withdrawal complete.");
    } catch (err) {
      setStatusMessage(null);
      log(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  const depositAmountNano = useMemo(() => {
    const needed = BigInt(effectiveDenom) + BigInt(1);
    return nano(needed);
  }, [effectiveDenom]);

  const depositUri = useMemo(() => {
    if (!source) return "";
    return `nano:${source.address}?amount=${depositAmountNano}`;
  }, [source, depositAmountNano]);

  const inputClass =
    "w-full rounded-lg border border-black/20 bg-white px-4 py-2 text-black focus:border-black focus:outline-none";

  const stepBase = "flex items-start gap-4 rounded-xl border border-black/10 bg-white p-5 transition-opacity";
  const stepInactive = "opacity-60";
  const stepNumber = "flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-black/20 text-sm font-semibold";

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

  return (
    <div className="mx-auto max-w-2xl px-4 py-12">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold">Wallet</h1>
          <p className="mt-2 text-black/50">Fund the source address, deposit, then withdraw privately.</p>
        </div>
        <Button variant="ghost" onClick={lock} className="shrink-0">Lock</Button>
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

      <div className="mt-6 space-y-4">
        <div className={`${stepBase} ${activeStep !== 1 ? stepInactive : ""}`}>
          <div className={stepNumber}>1</div>
          <div className="flex-1">
            <h2 className="font-semibold">Fund your source address</h2>
            <p className="text-sm text-black/50">Send exactly <strong>{depositAmountNano} XNO</strong> to this address.</p>
            {source && (
              <div className="mt-4">
                <div className="flex items-center gap-2">
                  <code className="break-all rounded-lg border border-black/10 bg-black/5 px-3 py-2 text-xs font-mono">{source.address}</code>
                  <button onClick={() => source && navigator.clipboard.writeText(source.address)} className="rounded-lg border border-black/20 px-3 py-2 text-sm hover:bg-black/5">Copy</button>
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
          </div>
        </div>

        <div className={`${stepBase} ${activeStep !== 2 ? stepInactive : ""}`}>
          <div className={stepNumber}>2</div>
          <div className="flex-1">
            <h2 className="font-semibold">Deposit into the pool</h2>
            <p className="text-sm text-black/50">Move {nano(BigInt(effectiveDenom))} XNO + 1 raw into the privacy pool.</p>
            {hasPending && !depositDone && (
              <p className="mt-2 text-sm text-black/70">Funding detected — you can deposit now.</p>
            )}
            <Button onClick={handleDeposit} disabled={busy || !hasFunds || depositDone} className="mt-4 w-full">
              {busy ? "Working..." : depositDone ? "Deposited" : "Deposit now"}
            </Button>
            {depositTx && (
              <div className="mt-3 flex flex-wrap gap-3 text-xs text-black/70">
                <a href={explorerLink(depositTx.depositHash)} target="_blank" rel="noreferrer" className="underline">Deposit tx</a>
                <a href={explorerLink(depositTx.commitHash)} target="_blank" rel="noreferrer" className="underline">Commit tx</a>
              </div>
            )}
          </div>
        </div>

        <div className={`${stepBase} ${activeStep !== 3 ? stepInactive : ""}`}>
          <div className={stepNumber}>3</div>
          <div className="flex-1">
            <h2 className="font-semibold">Withdraw to a fresh address</h2>
            <p className="text-sm text-black/50">Receive {nano(BigInt(effectiveDenom) - BigInt(1e28))} XNO minus the 0.01 XNO guardian fee.</p>
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
          <p className="mt-3 font-mono text-sm text-black">{phrase}</p>
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
