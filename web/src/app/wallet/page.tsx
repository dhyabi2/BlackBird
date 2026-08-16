"use client";

import "@/lib/polyfills";
import { useEffect, useMemo, useState } from "react";
import { deriveLegacyAccount, buildSendBlock } from "@/lib/wallet";
import { computeCommitment, computeNullifier, hexToBytes, bytesToHex } from "@/lib/vela-crypto";
import { blake2b } from "blakejs";
import { Button } from "@/components/ui/Button";

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

export default function WalletPage() {
  const [seed, setSeed] = useState("");
  const [sourceIndex, setSourceIndex] = useState(0);
  const [withdrawIndex, setWithdrawIndex] = useState(1);
  const [denomRaw, setDenomRaw] = useState(DENOMINATIONS[1].raw);
  const [busy, setBusy] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [poolPub, setPoolPub] = useState<string | null>(null);
  const [status, setStatus] = useState<{ epoch?: number } | null>(null);

  const source = useMemo(() => {
    if (!/^[0-9a-fA-F]{64}$/.test(seed)) return null;
    try {
      return deriveLegacyAccount(seed, sourceIndex);
    } catch {
      return null;
    }
  }, [seed, sourceIndex]);

  const withdraw = useMemo(() => {
    if (!/^[0-9a-fA-F]{64}$/.test(seed)) return null;
    try {
      return deriveLegacyAccount(seed, withdrawIndex);
    } catch {
      return null;
    }
  }, [seed, withdrawIndex]);

  useEffect(() => {
    apiGet("/api/status").then((s) => setStatus(s)).catch(() => setStatus(null));
    apiGet(`/api/pool_address/${denomRaw}`).then((p) => setPoolPub(p.pool_pubkey ?? null)).catch(() => setPoolPub(null));
  }, [denomRaw]);

  function log(msg: string) {
    setLogs((prev) => [...prev, `${new Date().toLocaleTimeString()} ${msg}`]);
  }

  async function fetchWork(hash: string): Promise<string> {
    const data = await apiPost("/api/work", {
      hash,
      difficulty: "fffffff800000000",
    });
    if (!data.work) throw new Error("work_generate failed");
    return data.work;
  }

  async function fetchAccountInfo(account: string) {
    const data = await apiGet(`/api/account_info?account=${encodeURIComponent(account)}`);
    if (data.error) throw new Error(data.error);
    return data as {
      balance: string;
      frontier: string;
      representative: string;
      block_count: string;
    };
  }

  async function broadcastBlock(block: Record<string, unknown>) {
    return apiPost("/api/broadcast", { block });
  }

  async function handleDeposit() {
    if (!source || !withdraw || !poolPub) return;
    setBusy(true);
    setLogs([]);

    try {
      const denom = Number(denomRaw);
      const poolData = await apiGet(`/api/pool_address/${denom}`);
      const poolAddress = poolData.pool_pubkey as string;
      const S_pub = hexToBytes(poolPub);
      const P_w = hexToBytes(withdraw.publicKey);
      const n = deriveSecretBytes(seed, withdraw.publicKey, "vela/n");
      const t = deriveSecretBytes(seed, withdraw.publicKey, "vela/t");
      const C = computeCommitment(n, t, P_w, S_pub);
      const C_hex = C.toString(16).padStart(64, "0");
      const nullifier = computeNullifier(n);

      log(`Source: ${source.address}`);
      log(`Withdraw: ${withdraw.address}`);
      log(`Commitment: ${C_hex}`);
      log(`Nullifier: ${nullifier.toString(16)}`);

      const info = await fetchAccountInfo(source.address);
      const balance = BigInt(info.balance);
      if (balance < BigInt(denom) + BigInt(1)) {
        throw new Error(`Insufficient balance: ${balance} raw`);
      }

      const depositBlock = buildSendBlock(source.secretKey, {
        previous: info.frontier,
        representative: info.representative,
        balance: (balance - BigInt(denom)).toString(),
        link: poolAddress,
        work: await fetchWork(info.frontier),
      });
      log(`Deposit hash: ${depositBlock.hash}`);
      await broadcastBlock(depositBlock.block);
      log("Deposit broadcasted");

      const commitBlock = buildSendBlock(source.secretKey, {
        previous: depositBlock.hash,
        representative: info.representative,
        balance: (balance - BigInt(denom) - BigInt(1)).toString(),
        link: C_hex,
        work: await fetchWork(depositBlock.hash),
      });
      log(`Commit hash: ${commitBlock.hash}`);
      await broadcastBlock(commitBlock.block);
      log("Commitment broadcasted");

      const depositRes = (await apiPost("/api/deposit", {
        deposit_hash: depositBlock.hash,
        commit_hash: commitBlock.hash,
      })) as { commitment?: string };
      log(`Indexer accepted commitment: ${depositRes.commitment}`);
    } catch (err) {
      log(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleWithdraw() {
    if (!source || !withdraw || !poolPub || !status?.epoch) return;
    setBusy(true);
    setLogs([]);

    try {
      const denom = Number(denomRaw);
      const n = deriveSecretBytes(seed, withdraw.publicKey, "vela/n");
      const t = deriveSecretBytes(seed, withdraw.publicKey, "vela/t");
      const nullifier = computeNullifier(n);

      log(`Withdraw to: ${withdraw.address}`);
      log(`Nullifier: ${nullifier.toString(16)}`);

      const proofRes = await apiPost("/api/prove", {
        n: bytesToHex(n),
        t: bytesToHex(t),
        P_w: withdraw.publicKey,
        nullifier: nullifier.toString(16),
        denomination: denom,
        epoch: status.epoch,
      });

      if (!proofRes.proof || !proofRes.publicSignals) {
        throw new Error("Proof generation failed");
      }
      log("Proof generated");

      const withdrawRes = (await apiPost("/api/withdraw", {
        destination: withdraw.address,
        epoch: status.epoch,
        denomination: denom,
        nullifier: nullifier.toString(16),
        proof: proofRes.proof,
        publicSignals: proofRes.publicSignals,
      })) as {
        ok?: boolean;
        block_hash?: string;
        block?: { previous?: string } & Record<string, unknown>;
      };

      if (!withdrawRes.block || !withdrawRes.block_hash) {
        throw new Error("Guardian did not return a block");
      }
      log(`Guardian signed withdrawal: ${withdrawRes.block_hash}`);

      // PoW for a state-block send must be computed on the previous block hash (pool frontier).
      const workHash = withdrawRes.block.previous ?? withdrawRes.block_hash;
      const work = await fetchWork(workHash);
      const signedBlock = { ...withdrawRes.block, work };
      await broadcastBlock(signedBlock);
      log("Withdrawal broadcasted");
    } catch (err) {
      log(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  const inputClass =
    "w-full rounded-lg border border-black/20 bg-white px-4 py-2 text-black focus:border-black focus:outline-none";

  return (
    <div className="mx-auto max-w-3xl px-4 py-12">
      <h1 className="text-3xl font-bold">Wallet</h1>
      <p className="mt-2 text-black/50">
        Client-side wallet. Your seed never leaves the browser. Generate a
        deposit, wait for it to be indexed, then withdraw.
      </p>

      <div className="mt-8 space-y-6 rounded-xl border border-black/10 bg-white p-6">
        <div>
          <label className="block text-sm font-medium text-black/70">
            Source seed (32-byte hex)
          </label>
          <input
            type="password"
            value={seed}
            onChange={(e) => setSeed(e.target.value)}
            placeholder="0000..."
            className={inputClass}
          />
          <p className="mt-1 text-xs text-black/50">
            Same 64-character hex seed used by the VELA CLI.
          </p>
        </div>

        <div className="grid grid-cols-3 gap-4">
          <div>
            <label className="block text-sm font-medium text-black/70">Source index</label>
            <input
              type="number"
              value={sourceIndex}
              onChange={(e) => setSourceIndex(Number(e.target.value))}
              className={inputClass}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-black/70">Withdraw index</label>
            <input
              type="number"
              value={withdrawIndex}
              onChange={(e) => setWithdrawIndex(Number(e.target.value))}
              className={inputClass}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-black/70">Denomination</label>
            <select
              value={denomRaw}
              onChange={(e) => setDenomRaw(e.target.value)}
              className={inputClass}
            >
              {DENOMINATIONS.map((d) => (
                <option key={d.raw} value={d.raw}>
                  {d.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        {source && (
          <div className="text-sm text-black/50">
            Source: <span className="font-mono text-black">{source.address}</span>
          </div>
        )}
        {withdraw && (
          <div className="text-sm text-black/50">
            Withdraw: <span className="font-mono text-black">{withdraw.address}</span>
          </div>
        )}

        <div className="flex gap-4">
          <Button
            onClick={handleDeposit}
            disabled={busy || !source || !withdraw}
            className="flex-1"
          >
            {busy ? "Working..." : "1. Deposit"}
          </Button>
          <Button
            onClick={handleWithdraw}
            disabled={busy || !source || !withdraw}
            variant="secondary"
            className="flex-1"
          >
            {busy ? "Working..." : "2. Withdraw"}
          </Button>
        </div>
      </div>

      {logs.length > 0 && (
        <div className="mt-8 rounded-xl border border-black/10 bg-black/5 p-6">
          <h2 className="mb-4 text-lg font-semibold">Activity log</h2>
          <pre className="max-h-96 overflow-auto font-mono text-xs text-black/70">
            {logs.join("\n")}
          </pre>
        </div>
      )}
    </div>
  );
}
