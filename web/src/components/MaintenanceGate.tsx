"use client";

import { useEffect, useState } from "react";
import { checkNetwork, type GateState } from "@/lib/network-gate";

/**
 * Replaces the entire app with a maintenance screen when the network is not
 * usable.
 *
 * Checked ONCE, on page load, and never again for the life of the page. That is
 * deliberate: a user who is mid-deposit must never have the UI yanked out from
 * under them because of a transient blip, and a half-finished shield needs the
 * app present to recover itself. The gate answers one question — "is it safe to
 * start?" — and then gets out of the way.
 */
function MaintenanceScreen({
  reason,
  onRetry,
  retrying,
}: {
  reason: string;
  onRetry: () => void;
  retrying: boolean;
}) {
  return (
    <div className="flex min-h-[70vh] items-center justify-center px-4 py-16">
      <div className="w-full max-w-md text-center">
        <div
          aria-hidden="true"
          className="mx-auto mb-6 flex h-14 w-14 items-center justify-center rounded-full border border-black/10 bg-black/5 text-2xl"
        >
          🛠️
        </div>
        <h1 className="text-xl font-semibold">Temporarily unavailable</h1>
        <p className="mt-3 text-sm text-black/60">{reason}</p>
        <p className="mt-4 text-sm text-black/60">
          <strong className="font-semibold text-black">
            Please do not send any funds right now.
          </strong>{" "}
          Nothing is lost — the privacy pool is untouched, and any XNO you have
          already shielded stays recoverable. Come back shortly and your wallet
          will pick up where it left off.
        </p>
        <button
          onClick={onRetry}
          disabled={retrying}
          className="mt-6 rounded-lg border border-black/20 px-4 py-2 text-sm transition-colors hover:bg-black/5 disabled:opacity-50"
        >
          {retrying ? "Checking..." : "Check again"}
        </button>
        <p className="mt-6 text-xs text-black/40">
          <a href="/status" className="underline">
            Service status
          </a>
        </p>
      </div>
    </div>
  );
}

export function MaintenanceGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<GateState>({ kind: "checking" });
  const [retrying, setRetrying] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void checkNetwork().then((s) => {
      if (!cancelled) setState(s);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // While the single check is in flight the app renders normally. Blanking the
  // page on every load would cost every visitor a flash of nothing (and hide
  // the content from crawlers) to catch a rare failure.
  if (state.kind === "down") {
    return (
      <MaintenanceScreen
        reason={state.reason}
        retrying={retrying}
        onRetry={() => {
          setRetrying(true);
          void checkNetwork().then((s) => {
            setState(s);
            setRetrying(false);
          });
        }}
      />
    );
  }

  return <>{children}</>;
}
