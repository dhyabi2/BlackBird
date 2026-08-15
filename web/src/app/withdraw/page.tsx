"use client";

import { useState } from "react";

export default function WithdrawPage() {
  const [destination, setDestination] = useState("");
  const [nullifier, setNullifier] = useState("");
  const [proofJson, setProofJson] = useState("");
  const [publicSignalsJson, setPublicSignalsJson] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setResult(null);

    try {
      const proof = JSON.parse(proofJson);
      const publicSignals = JSON.parse(publicSignalsJson);

      const res = await fetch("/api/withdraw", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ destination, nullifier, proof, publicSignals }),
      });
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || "Withdrawal request failed");
      }

      setResult({ ok: true, message: "Withdrawal request accepted." });
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
      <h1 className="text-3xl font-bold">Withdraw</h1>
      <p className="mt-2 text-zinc-400">
        Provide a fresh destination address and your zero-knowledge proof. The
        nullifier ensures you cannot withdraw the same deposit twice.
      </p>

      <form onSubmit={handleSubmit} className="mt-8 space-y-6">
        <div>
          <label className="block text-sm font-medium text-zinc-300">
            Destination Nano account
          </label>
          <input
            type="text"
            required
            value={destination}
            onChange={(e) => setDestination(e.target.value)}
            placeholder="nano_..."
            className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-2 text-zinc-100 focus:border-emerald-500 focus:outline-none"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-zinc-300">
            Nullifier
          </label>
          <input
            type="text"
            required
            value={nullifier}
            onChange={(e) => setNullifier(e.target.value)}
            placeholder="0x..."
            className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-2 text-zinc-100 focus:border-emerald-500 focus:outline-none"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-zinc-300">
            Proof (JSON)
          </label>
          <textarea
            required
            rows={4}
            value={proofJson}
            onChange={(e) => setProofJson(e.target.value)}
            placeholder='{"pi_a":[...], ...}'
            className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-2 font-mono text-sm text-zinc-100 focus:border-emerald-500 focus:outline-none"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-zinc-300">
            Public signals (JSON array)
          </label>
          <textarea
            required
            rows={3}
            value={publicSignalsJson}
            onChange={(e) => setPublicSignalsJson(e.target.value)}
            placeholder='["root","nullifier",...]'
            className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-2 font-mono text-sm text-zinc-100 focus:border-emerald-500 focus:outline-none"
          />
        </div>

        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-lg bg-emerald-500 px-4 py-3 font-semibold text-zinc-950 hover:bg-emerald-400 disabled:opacity-50"
        >
          {loading ? "Submitting..." : "Request withdrawal"}
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
