import Link from "next/link";

export default function HomePage() {
  return (
    <div className="mx-auto max-w-5xl px-4 py-16">
      <div className="text-center">
        <h1 className="text-4xl font-extrabold tracking-tight sm:text-6xl">
          VELA <span className="text-emerald-400">v2</span>
        </h1>
        <p className="mx-auto mt-6 max-w-2xl text-lg text-zinc-400">
          A zero-knowledge privacy pool on Nano. Deposit, wait, and withdraw to
          a fresh address without linking the two on-chain.
        </p>
        <div className="mt-10 flex flex-wrap justify-center gap-4">
          <Link
            href="/easy"
            className="rounded-lg bg-emerald-500 px-6 py-3 font-semibold text-zinc-950 hover:bg-emerald-400"
          >
            Easy wallet
          </Link>
          <Link
            href="/deposit"
            className="rounded-lg border border-zinc-700 bg-zinc-900 px-6 py-3 font-semibold hover:border-zinc-500"
          >
            Make a deposit
          </Link>
          <Link
            href="/withdraw"
            className="rounded-lg border border-zinc-700 bg-zinc-900 px-6 py-3 font-semibold hover:border-zinc-500"
          >
            Withdraw
          </Link>
        </div>
        <p className="mt-4 text-sm text-zinc-500">
          New users should start with the Easy wallet. Advanced users can use the
          {" "}
          <Link href="/wallet" className="underline hover:text-zinc-300">
            full wallet
          </Link>
          .
        </p>
      </div>

      <div className="mt-20 grid gap-6 sm:grid-cols-3">
        <FeatureCard
          title="Pure Nano"
          description="No external smart contracts. Economic security uses multi-sig bonds, fraud proofs, and threshold signatures."
        />
        <FeatureCard
          title="ZK Privacy"
          description="Groth16 proofs over BN254 keep your deposit secret while proving it is part of the pool."
        />
        <FeatureCard
          title="Decentralized"
          description="t-of-n FROST guardians, deterministic indexers, and censorship-resistant discovery."
        />
      </div>
    </div>
  );
}

function FeatureCard({ title, description }: { title: string; description: string }) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-6">
      <h3 className="text-lg font-semibold text-emerald-400">{title}</h3>
      <p className="mt-2 text-sm text-zinc-400">{description}</p>
    </div>
  );
}
