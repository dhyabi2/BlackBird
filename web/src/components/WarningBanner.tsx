"use client";

import { useState } from "react";

export function WarningBanner() {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;

  return (
    <div className="flex flex-col items-center justify-center gap-2 border-b border-black/10 bg-white px-4 py-3 text-center text-sm text-black sm:flex-row">
      <span>
        <span className="font-semibold">Warning:</span> This is an unaudited
        prototype. Do not deposit mainnet funds you cannot afford to lose.
      </span>
      <button
        onClick={() => setDismissed(true)}
        className="underline hover:text-black/60 sm:ml-2"
      >
        Dismiss
      </button>
    </div>
  );
}
