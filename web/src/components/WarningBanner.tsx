"use client";

import { useState } from "react";

export function WarningBanner() {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;

  return (
    <div className="border-b border-black/10 bg-white px-4 py-3 text-center text-sm text-black">
      <span className="font-semibold">Warning:</span> This is an unaudited
      prototype. Do not deposit mainnet funds you cannot afford to lose.
      <button
        onClick={() => setDismissed(true)}
        className="ml-4 underline hover:text-black/60"
      >
        Dismiss
      </button>
    </div>
  );
}
