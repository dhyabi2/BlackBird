"use client";

import { useEffect, useState } from "react";

export default function StatusPage() {
  const [health, setHealth] = useState<unknown>(null);
  const [status, setStatus] = useState<unknown>(null);
  const [account, setAccount] = useState("");
  const [balance, setBalance] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.json())
      .then(setHealth)
      .catch(() => setHealth({ error: "Health check failed" }));

    fetch("/api/status")
      .then((r) => r.json())
      .then(setStatus)
      .catch(() => setStatus({ error: "Status check failed" }));
  }, []);

  async function lookupBalance(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      const res = await fetch(`/api/balance?account=${encodeURIComponent(account)}`);
      const data = await res.json();
      setBalance(data);
    } catch (err) {
      setBalance({ error: err instanceof Error ? err.message : "Failed" });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-12">
      <h1 className="text-3xl font-bold">Network status</h1>

      <div className="mt-8 grid gap-6">
        <StatusCard title="Vercel / RPC health" data={health} />
        <StatusCard title="VELA pool status" data={status} />
      </div>

      <form onSubmit={lookupBalance} className="mt-10 space-y-4">
        <h2 className="text-xl font-semibold">Account balance</h2>
        <div className="flex gap-3">
          <input
            type="text"
            value={account}
            onChange={(e) => setAccount(e.target.value)}
            placeholder="nano_..."
            className="flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-2 text-zinc-100 focus:border-emerald-500 focus:outline-none"
          />
          <button
            type="submit"
            disabled={loading}
            className="rounded-lg bg-emerald-500 px-4 py-2 font-semibold text-zinc-950 hover:bg-emerald-400 disabled:opacity-50"
          >
            Lookup
          </button>
        </div>
        {balance ? <StatusCard title="Balance" data={balance} /> : null}
      </form>
    </div>
  );
}

function StatusCard({ title, data }: { title: string; data: unknown }) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-6">
      <h3 className="text-lg font-semibold text-emerald-400">{title}</h3>
      <pre className="mt-4 overflow-x-auto rounded-lg bg-zinc-950 p-4 text-xs text-zinc-300">
        {JSON.stringify(data, null, 2) as string}
      </pre>
    </div>
  );
}
