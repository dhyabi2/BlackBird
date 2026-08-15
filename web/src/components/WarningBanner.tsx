"use client";

import { useState } from "react";

export function WarningBanner() {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;

  return (
    <div className="bg-amber-500/10 px-4 py-3 text-center text-sm text-amber-200">
      <span className="font-semibold">Warning:</span> This is an unaudited
      prototype. Do not deposit mainnet funds you cannot afford to lose.
      <button
        onClick={() => setDismissed(true)}
        className="ml-4 text-amber-400 underline hover:text-amber-300"
      >
        Dismiss
      </button>
    </div>
  );
}
