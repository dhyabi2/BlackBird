"use client";

import "@/lib/polyfills";
import { useEffect, useMemo, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { deriveLegacyAccount, buildSendBlock } from "@/lib/wallet";
import { encryptSeed, decryptSeed } from "@/lib/crypto-storage";
import { createBackupPhrase, phraseToSeedHex } from "@/lib/mnemonic";
import { computeCommitment, computeNullifier, hexToBytes, bytesToHex } from "@/lib/vela-crypto";
import { blake2b } from "blakejs";
import { convert, Unit } from "nanocurrency";

const STORAGE_KEY = "vela_wallet_v1";

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

export default function EasyWallet() {
  const [password, setPassword] = useState("");
  const [passwordConfirm, setPasswordConfirm] = useState("");
  const [phrase, setPhrase] = useState("");
  const [seed, setSeed] = useState<string | null>(null);
  const [stored, setStored] = useState<string | null>(() =>
    typeof window !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null
  );
  const [view, setView] = useState<"locked" | "create" | "restore" | "dashboard">(() =>
    typeof window !== "undefined" && localStorage.getItem(STORAGE_KEY) ? "locked" : "create"
  );
  const [error, setError] = useState<string | null>(null);

  const [sourceIndex] = useState(0);
  const [withdrawIndex, setWithdrawIndex] = useState(1);
  const [denomRaw, setDenomRaw] = useState(DENOMINATIONS[0].raw);
  const [epoch, setEpoch] = useState<number | null>(null);
  const [balance, setBalance] = useState<string | null>(null);
  const [sourceInfo, setSourceInfo] = useState<{ frontier?: string; representative?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [lastWithdrawAddress, setLastWithdrawAddress] = useState<string | null>(null);

  useEffect(() => {
    apiGet("/api/status")
      .then((s) => setEpoch(s.epoch ?? null))
      .catch(() => null);
  }, []);

  const source = useMemo(() => (seed ? deriveLegacyAccount(seed, sourceIndex) : null), [seed, sourceIndex]);
  const withdraw = useMemo(() => (seed ? deriveLegacyAccount(seed, withdrawIndex) : null), [seed, withdrawIndex]);

  useEffect(() => {
    if (!source) return;
    const address = source.address;
    let alive = true;
    async function poll() {
      try {
        const info = await apiGet(`/api/account_info?account=${encodeURIComponent(address)}`);
        if (!alive) return;
        setBalance(info.balance ?? "0");
        setSourceInfo({ frontier: info.frontier, representative: info.representative });
      } catch {
        setBalance(null);
        setSourceInfo(null);
      }
    }
    poll();
    const id = setInterval(poll, 10_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [source]);

  function log(msg: string) {
    setLogs((prev) => [...prev, `${new Date().toLocaleTimeString()} ${msg}`]);
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

  async function handleCompleteDeposit() {
    if (!source || !withdraw || !sourceInfo || !balance) return;
    setBusy(true);
    try {
      const denom = BigInt(denomRaw);
      const bal = BigInt(balance);
      if (bal < denom + BigInt(1)) {
        throw new Error(`Need at least ${rawToNano((denom + BigInt(1)).toString())} XNO in source address`);
      }

      const poolData = await apiGet(`/api/pool_address/${denomRaw}`);
      const poolPubHex = poolData.pool_pubkey as string;
      const S_pub = hexToBytes(poolPubHex);
      const P_w = hexToBytes(withdraw.publicKey);
      const n = deriveSecretBytes(seed!, withdraw.publicKey, "vela/n");
      const t = deriveSecretBytes(seed!, withdraw.publicKey, "vela/t");
      const C = computeCommitment(n, t, P_w, S_pub);
      const C_hex = C.toString(16).padStart(64, "0");
      log(`Commitment: ${C_hex.slice(0, 16)}...`);

      // Deposit block
      const depositBlock = buildSendBlock(source.secretKey, {
        previous: sourceInfo.frontier!,
        representative: sourceInfo.representative!,
        balance: (bal - denom).toString(),
        link: poolPubHex,
        work: (await apiPost("/api/work", { hash: sourceInfo.frontier, difficulty: "fffffff800000000" })).work,
      });
      log(`Deposit hash: ${depositBlock.hash}`);
      await apiPost("/api/broadcast", { block: depositBlock.block });
      log("Deposit broadcasted");

      // Commit block
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
      log("Indexer accepted deposit. Wait a moment, then withdraw.");
    } catch (err) {
      log(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleWithdraw() {
    if (!source || !withdraw || !epoch) return;
    setBusy(true);
    try {
      const denom = denomRaw;
      const n = deriveSecretBytes(seed!, withdraw.publicKey, "vela/n");
      const t = deriveSecretBytes(seed!, withdraw.publicKey, "vela/t");
      const nullifier = computeNullifier(n);
      log(`Withdrawing to: ${withdraw.address}`);

      const proofRes = await apiPost("/api/prove", {
        n: bytesToHex(n),
        t: bytesToHex(t),
        P_w: withdraw.publicKey,
        nullifier: nullifier.toString(16),
        denomination: String(denom),
        epoch,
      });
      if (!proofRes.proof || !proofRes.publicSignals) throw new Error("Proof failed");
      log("Proof generated");

      const withdrawRes = await apiPost("/api/withdraw", {
        destination: withdraw.address,
        epoch,
        denomination: String(denom),
        nullifier: nullifier.toString(16),
        proof: proofRes.proof,
        publicSignals: proofRes.publicSignals,
      });
      if (!withdrawRes.block || !withdrawRes.block_hash) throw new Error("Guardian did not return a block");

      const work = (await apiPost("/api/work", { hash: withdrawRes.block_hash, difficulty: "fffffff800000000" })).work;
      await apiPost("/api/broadcast", { block: { ...withdrawRes.block, work } });
      log(`Withdrawal broadcasted to ${withdraw.address}`);
      setLastWithdrawAddress(withdraw.address);
      setWithdrawIndex((i) => i + 1);
    } catch (err) {
      log(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  const depositAmountNano = useMemo(() => {
    const needed = BigInt(denomRaw) + BigInt(1);
    return rawToNano(needed.toString());
  }, [denomRaw]);

  const depositUri = useMemo(() => {
    if (!source) return "";
    return `nano:${source.address}?amount=${depositAmountNano}`;
  }, [source, depositAmountNano]);

  if (view === "create") {
    return (
      <div className="mx-auto max-w-md px-4 py-16">
        <h1 className="text-3xl font-bold">Create wallet</h1>
        <p className="mt-2 text-zinc-400">
          Set a password to encrypt your wallet in this browser.
        </p>
        {error && <p className="mt-4 text-red-400">{error}</p>}
        <div className="mt-6 space-y-4">
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-2 text-zinc-100"
          />
          <input
            type="password"
            placeholder="Confirm password"
            value={passwordConfirm}
            onChange={(e) => setPasswordConfirm(e.target.value)}
            className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-2 text-zinc-100"
          />
          <button
            onClick={handleCreate}
            className="w-full rounded-lg bg-emerald-500 px-4 py-3 font-semibold text-zinc-950 hover:bg-emerald-400"
          >
            Create encrypted wallet
          </button>
          <button
            onClick={() => setView("restore")}
            className="w-full text-sm text-zinc-500 hover:text-zinc-300"
          >
            Restore from phrase
          </button>
        </div>
      </div>
    );
  }

  if (view === "restore") {
    return (
      <div className="mx-auto max-w-md px-4 py-16">
        <h1 className="text-3xl font-bold">Restore wallet</h1>
        <p className="mt-2 text-zinc-400">Enter your 24-word recovery phrase.</p>
        {error && <p className="mt-4 text-red-400">{error}</p>}
        <div className="mt-6 space-y-4">
          <textarea
            value={phrase}
            onChange={(e) => setPhrase(e.target.value)}
            placeholder="abandon abandon ability ..."
            rows={4}
            className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-2 text-zinc-100"
          />
          <input
            type="password"
            placeholder="New password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-2 text-zinc-100"
          />
          <button
            onClick={handleRestore}
            className="w-full rounded-lg bg-emerald-500 px-4 py-3 font-semibold text-zinc-950 hover:bg-emerald-400"
          >
            Restore
          </button>
          <button onClick={() => setView("create")} className="w-full text-sm text-zinc-500 hover:text-zinc-300">
            Create new wallet
          </button>
        </div>
      </div>
    );
  }

  if (view === "locked") {
    return (
      <div className="mx-auto max-w-md px-4 py-16">
        <h1 className="text-3xl font-bold">Unlock wallet</h1>
        {error && <p className="mt-4 text-red-400">{error}</p>}
        <div className="mt-6 space-y-4">
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-2 text-zinc-100"
          />
          <button
            onClick={handleUnlock}
            className="w-full rounded-lg bg-emerald-500 px-4 py-3 font-semibold text-zinc-950 hover:bg-emerald-400"
          >
            Unlock
          </button>
          <button onClick={() => setView("restore")} className="w-full text-sm text-zinc-500 hover:text-zinc-300">
            Restore from phrase
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-12">
      <h1 className="text-3xl font-bold">Easy Wallet</h1>
      <p className="mt-2 text-zinc-400">
        Source: <span className="font-mono text-emerald-400">{source?.address}</span>
      </p>
      <p className="text-sm text-zinc-500">
        Balance: {balance ? `${rawToNano(balance)} XNO` : "—"}
      </p>

      <div className="mt-8 rounded-xl border border-zinc-800 bg-zinc-900/50 p-6">
        <h2 className="text-xl font-semibold">1. Deposit</h2>
        <label className="mt-4 block text-sm font-medium text-zinc-300">Amount</label>
        <select
          value={denomRaw}
          onChange={(e) => setDenomRaw(e.target.value)}
          className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-4 py-2 text-zinc-100"
        >
          {DENOMINATIONS.map((d) => (
            <option key={d.raw} value={d.raw}>{d.label}</option>
          ))}
        </select>

        <div className="mt-6">
          <p className="text-sm text-zinc-300">
            Send <strong>at least {depositAmountNano} XNO</strong> to your source address.
          </p>
          <p className="mt-1 text-xs text-zinc-400">
            {rawToNano(denomRaw)} XNO goes into the pool and 1 raw is used for the commitment
            block. Anything extra stays in your source address.
          </p>
          <div className="mt-3 flex flex-col items-center gap-3 rounded-lg bg-white p-4">
            {depositUri && <QRCodeSVG value={depositUri} size={180} />}
            <code className="text-xs text-zinc-900 break-all">{source?.address}</code>
          </div>
          <p className="mt-2 text-xs text-zinc-500">
            Or use this URI in a Nano wallet: <code className="break-all">{depositUri}</code>
          </p>
        </div>

        <button
          onClick={handleCompleteDeposit}
          disabled={busy || !balance || BigInt(balance) < BigInt(denomRaw) + BigInt(1)}
          className="mt-6 w-full rounded-lg bg-emerald-500 px-4 py-3 font-semibold text-zinc-950 hover:bg-emerald-400 disabled:opacity-50"
        >
          {busy ? "Working..." : "Complete deposit"}
        </button>
      </div>

      <div className="mt-6 rounded-xl border border-zinc-800 bg-zinc-900/50 p-6">
        <h2 className="text-xl font-semibold">2. Withdraw</h2>
        <p className="mt-2 text-sm text-zinc-400">
          After the deposit is indexed, withdraw to a fresh address.
        </p>
        <button
          onClick={handleWithdraw}
          disabled={busy}
          className="mt-4 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-4 py-3 font-semibold hover:border-zinc-500 disabled:opacity-50"
        >
          {busy ? "Working..." : "Withdraw"}
        </button>
        {lastWithdrawAddress && (
          <p className="mt-4 text-sm text-emerald-400">
            Last withdrawal: <span className="font-mono">{lastWithdrawAddress}</span>
          </p>
        )}
      </div>

      {phrase && (
        <div className="mt-6 rounded-xl border border-amber-500/30 bg-amber-500/10 p-6">
          <h3 className="font-semibold text-amber-200">Recovery phrase</h3>
          <p className="mt-1 text-sm text-amber-200/80">
            Save these 24 words. They are the only way to recover this wallet.
          </p>
          <p className="mt-3 font-mono text-sm text-amber-100">{phrase}</p>
        </div>
      )}

      {logs.length > 0 && (
        <div className="mt-8 rounded-xl border border-zinc-800 bg-zinc-950 p-6">
          <h2 className="mb-4 text-lg font-semibold">Activity log</h2>
          <pre className="max-h-64 overflow-auto font-mono text-xs text-zinc-300">
            {logs.join("\n")}
          </pre>
        </div>
      )}
    </div>
  );
}
