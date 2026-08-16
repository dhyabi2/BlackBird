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
import { Button } from "@/components/ui/Button";

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
  const [depositDone, setDepositDone] = useState(false);

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

  async function handleDeposit() {
    if (!source || !withdraw || !sourceInfo || !balance) return;
    setBusy(true);
    try {
      const denom = BigInt(denomRaw);
      const bal = BigInt(balance);
      if (bal < denom + BigInt(1)) {
        throw new Error(`Send at least ${rawToNano((denom + BigInt(1)).toString())} XNO to your source address first`);
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
      setDepositDone(true);
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
      const n = deriveSecretBytes(seed!, withdraw.publicKey, "vela/n");
      const t = deriveSecretBytes(seed!, withdraw.publicKey, "vela/t");
      const nullifier = computeNullifier(n);
      log(`Withdrawing to: ${withdraw.address}`);

      const proofRes = await apiPost("/api/prove", {
        n: bytesToHex(n),
        t: bytesToHex(t),
        P_w: withdraw.publicKey,
        nullifier: nullifier.toString(16),
        denomination: String(denomRaw),
        epoch,
      });
      if (!proofRes.proof || !proofRes.publicSignals) throw new Error("Proof failed");
      log("Proof generated");

      const withdrawRes = await apiPost("/api/withdraw", {
        destination: withdraw.address,
        epoch,
        denomination: String(denomRaw),
        nullifier: nullifier.toString(16),
        proof: proofRes.proof,
        publicSignals: proofRes.publicSignals,
      });
      if (!withdrawRes.block || !withdrawRes.block_hash) throw new Error("Guardian did not return a block");

      // PoW must be computed on the pool frontier (the block's previous field), not the block hash.
      const workHash = typeof withdrawRes.block.previous === "string" ? withdrawRes.block.previous : withdrawRes.block_hash;
      const work = (await apiPost("/api/work", { hash: workHash, difficulty: "fffffff800000000" })).work;
      await apiPost("/api/broadcast", { block: { ...withdrawRes.block, work } });
      log(`Withdrawal broadcasted to ${withdraw.address}`);
      setLastWithdrawAddress(withdraw.address);
      setWithdrawIndex((i) => i + 1);
      setDepositDone(false);
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

  const inputClass =
    "w-full rounded-lg border border-black/20 bg-white px-4 py-2 text-black focus:border-black focus:outline-none";

  const stepClass = "flex items-start gap-4 rounded-xl border border-black/10 bg-white p-5";
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

  const canDeposit = Boolean(balance && BigInt(balance) >= BigInt(denomRaw) + BigInt(1) && !depositDone);

  return (
    <div className="mx-auto max-w-2xl px-4 py-12">
      <h1 className="text-3xl font-bold">Wallet</h1>
      <p className="mt-2 text-black/50">Deposit into the pool, then withdraw to a fresh address. The app handles the proof.</p>

      <div className="mt-6 flex items-center justify-between">
        <label className="text-sm font-medium text-black/70">Amount</label>
        <select value={denomRaw} onChange={(e) => setDenomRaw(e.target.value)} className="rounded-lg border border-black/20 bg-white px-3 py-1 text-sm text-black focus:border-black focus:outline-none">
          {DENOMINATIONS.map((d) => (
            <option key={d.raw} value={d.raw}>{d.label}</option>
          ))}
        </select>
      </div>

      <div className="mt-8 space-y-4">
        <div className={stepClass}>
          <div className={stepNumber}>1</div>
          <div className="flex-1">
            <h2 className="font-semibold">Fund your source address</h2>
            <p className="text-sm text-black/50">Send at least <strong>{depositAmountNano} XNO</strong> to this address.</p>
            {source && (
              <div className="mt-4">
                <div className="flex items-center gap-2">
                  <code className="break-all rounded-lg border border-black/10 bg-black/5 px-3 py-2 text-xs font-mono">{source.address}</code>
                  <button
                    onClick={() => source && navigator.clipboard.writeText(source.address)}
                    className="rounded-lg border border-black/20 px-3 py-2 text-sm hover:bg-black/5"
                  >
                    Copy
                  </button>
                </div>
                <div className="mt-4 inline-block rounded-lg border border-black/10 bg-white p-4">
                  {depositUri && <QRCodeSVG value={depositUri} size={160} />}
                </div>
                <p className="mt-2 text-xs text-black/50">Balance: {balance ? `${rawToNano(balance)} XNO` : "—"}</p>
              </div>
            )}
          </div>
        </div>

        <div className={stepClass}>
          <div className={stepNumber}>2</div>
          <div className="flex-1">
            <h2 className="font-semibold">Deposit into the pool</h2>
            <p className="text-sm text-black/50">Move {rawToNano(denomRaw)} XNO + 1 raw into the privacy pool.</p>
            <Button onClick={handleDeposit} disabled={busy || !canDeposit} className="mt-4 w-full">
              {busy ? "Working..." : depositDone ? "Deposited" : "Deposit now"}
            </Button>
          </div>
        </div>

        <div className={stepClass}>
          <div className={stepNumber}>3</div>
          <div className="flex-1">
            <h2 className="font-semibold">Withdraw to a fresh address</h2>
            <p className="text-sm text-black/50">After the deposit is indexed, withdraw privately.</p>
            <Button onClick={handleWithdraw} disabled={busy || !depositDone} variant="secondary" className="mt-4 w-full">
              {busy ? "Working..." : "Withdraw now"}
            </Button>
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
