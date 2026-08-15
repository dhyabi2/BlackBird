"use client";

import { useState } from "react";

export default function DepositPage() {
  const [depositHash, setDepositHash] = useState("");
  const [commitHash, setCommitHash] = useState("");
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
        body: JSON.stringify({ deposit_hash: depositHash, commit_hash: commitHash }),
      });
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || "Deposit request failed");
      }

      setResult({ ok: true, message: `Deposit accepted. Commitment: ${data.commitment}` });
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
        Submit the deposit block hash and the commitment block hash. The indexer
        will verify the pair and add the commitment to the pool.
      </p>

      <form onSubmit={handleSubmit} className="mt-8 space-y-6">
        <div>
          <label className="block text-sm font-medium text-zinc-300">
            Deposit block hash
          </label>
          <input
            type="text"
            required
            value={depositHash}
            onChange={(e) => setDepositHash(e.target.value)}
            placeholder="ABC123..."
            className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-2 text-zinc-100 focus:border-emerald-500 focus:outline-none"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-zinc-300">
            Commitment block hash
          </label>
          <input
            type="text"
            required
            value={commitHash}
            onChange={(e) => setCommitHash(e.target.value)}
            placeholder="DEF456..."
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
