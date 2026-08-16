"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";

export default function WithdrawPage() {
  const [destination, setDestination] = useState("");
  const [epoch, setEpoch] = useState("");
  const [denomination, setDenomination] = useState("");
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
        body: JSON.stringify({
          destination,
          epoch: Number(epoch),
          denomination,
          nullifier,
          proof,
          publicSignals,
        }),
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

  const inputClass =
    "w-full rounded-lg border border-black/20 bg-white px-4 py-2 text-black focus:border-black focus:outline-none";

  return (
    <div className="mx-auto max-w-2xl px-4 py-12">
      <h1 className="text-3xl font-bold">Withdraw</h1>
      <p className="mt-2 text-black/50">
        Provide a fresh destination address, epoch, denomination, and your
        zero-knowledge proof. The nullifier ensures you cannot withdraw the same
        deposit twice.
      </p>

      <form onSubmit={handleSubmit} className="mt-8 space-y-6">
        <div>
          <label className="block text-sm font-medium text-black/70">
            Destination Nano account
          </label>
          <input
            type="text"
            required
            value={destination}
            onChange={(e) => setDestination(e.target.value)}
            placeholder="nano_..."
            className={inputClass}
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-black/70">Epoch</label>
            <input
              type="number"
              required
              value={epoch}
              onChange={(e) => setEpoch(e.target.value)}
              placeholder="123"
              className={inputClass}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-black/70">
              Denomination (raw)
            </label>
            <input
              type="text"
              required
              value={denomination}
              onChange={(e) => setDenomination(e.target.value)}
              placeholder="1000000000000000000000000000000"
              className={inputClass}
            />
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-black/70">Nullifier</label>
          <input
            type="text"
            required
            value={nullifier}
            onChange={(e) => setNullifier(e.target.value)}
            placeholder="0x..."
            className={inputClass}
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-black/70">Proof (JSON)</label>
          <textarea
            required
            rows={4}
            value={proofJson}
            onChange={(e) => setProofJson(e.target.value)}
            placeholder='{"pi_a":[...], ...}'
            className={`${inputClass} font-mono text-sm`}
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-black/70">
            Public signals (JSON array)
          </label>
          <textarea
            required
            rows={3}
            value={publicSignalsJson}
            onChange={(e) => setPublicSignalsJson(e.target.value)}
            placeholder='["root","nullifier","P_w_lo","P_w_hi"]'
            className={`${inputClass} font-mono text-sm`}
          />
        </div>

        <Button type="submit" disabled={loading} className="w-full">
          {loading ? "Submitting..." : "Request withdrawal"}
        </Button>

        {result && (
          <div className="rounded-lg border border-black/10 bg-black/5 px-4 py-3 text-sm text-black">
            {result.message}
          </div>
        )}
      </form>
    </div>
  );
}
