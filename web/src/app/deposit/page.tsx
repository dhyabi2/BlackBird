"use client";

import { useState } from "react";

export default function DepositPage() {
  const [account, setAccount] = useState("");
  const [amountRaw, setAmountRaw] = useState("");
  const [commitment, setCommitment] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setResult(null);

    try {
      const res = await fetch("/api/deposit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ account, amountRaw, commitment }),
      });
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || "Deposit request failed");
      }

      setResult({ ok: true, message: "Deposit request accepted." });
    } catch (err) {
      setResult({
        ok: false,
        message: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-12">
      <h1 className="text-3xl font-bold">Deposit</h1>
      <p className="mt-2 text-zinc-400">
        Generate a commitment locally, then send the exact amount to the pool
        address and submit the receipt here.
      </p>

      <form onSubmit={handleSubmit} className="mt-8 space-y-6">
        <div>
          <label className="block text-sm font-medium text-zinc-300">
            Sender Nano account
          </label>
          <input
            type="text"
            required
            value={account}
            onChange={(e) => setAccount(e.target.value)}
            placeholder="nano_..."
            className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-2 text-zinc-100 focus:border-emerald-500 focus:outline-none"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-zinc-300">
            Amount (raw)
          </label>
          <input
            type="text"
            required
            value={amountRaw}
            onChange={(e) => setAmountRaw(e.target.value)}
            placeholder="1000000000000000000000000000000"
            className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-2 text-zinc-100 focus:border-emerald-500 focus:outline-none"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-zinc-300">
            Commitment
          </label>
          <input
            type="text"
            required
            value={commitment}
            onChange={(e) => setCommitment(e.target.value)}
            placeholder="0x..."
            className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-2 text-zinc-100 focus:border-emerald-500 focus:outline-none"
          />
        </div>

        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-lg bg-emerald-500 px-4 py-3 font-semibold text-zinc-950 hover:bg-emerald-400 disabled:opacity-50"
        >
          {loading ? "Submitting..." : "Submit deposit"}
        </button>

        {result && (
          <div
            className={`rounded-lg px-4 py-3 text-sm ${
              result.ok
                ? "bg-emerald-500/10 text-emerald-200"
                : "bg-red-500/10 text-red-200"
            }`}
          >
            {result.message}
          </div>
        )}
      </form>
    </div>
  );
}
