"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";

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

  const inputClass =
    "w-full rounded-lg border border-black/20 bg-white px-4 py-2 text-black focus:border-black focus:outline-none";

  return (
    <div className="mx-auto max-w-2xl px-4 py-12">
      <h1 className="text-3xl font-bold">Deposit</h1>
      <p className="mt-2 text-black/50">
        Submit the deposit block hash and the commitment block hash. The indexer
        will verify the pair and add the commitment to the pool.
      </p>

      <form onSubmit={handleSubmit} className="mt-8 space-y-6">
        <div>
          <label className="block text-sm font-medium text-black/70">
            Deposit block hash
          </label>
          <input
            type="text"
            required
            value={depositHash}
            onChange={(e) => setDepositHash(e.target.value)}
            placeholder="ABC123..."
            className={inputClass}
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-black/70">
            Commitment block hash
          </label>
          <input
            type="text"
            required
            value={commitHash}
            onChange={(e) => setCommitHash(e.target.value)}
            placeholder="DEF456..."
            className={inputClass}
          />
        </div>

        <Button type="submit" disabled={loading} className="w-full">
          {loading ? "Submitting..." : "Submit deposit"}
        </Button>

        {result && (
          <div
            className={`rounded-lg border px-4 py-3 text-sm ${
              result.ok
                ? "border-black/10 bg-black/5 text-black"
                : "border-black/10 bg-black/5 text-black"
            }`}
          >
            {result.message}
          </div>
        )}
      </form>
    </div>
  );
}
