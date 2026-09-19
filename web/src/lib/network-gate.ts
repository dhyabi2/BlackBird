/**
 * Decides whether it is safe to start a transaction, for MaintenanceGate.
 *
 * Kept out of the component so the decision — the part that can strand users or
 * needlessly close the app — is directly testable.
 */
export type GateState =
  | { kind: "checking" }
  | { kind: "up" }
  | { kind: "down"; reason: string };

type Fetcher = typeof fetch;

/** One liveness attempt: null on success, else the reason it failed. */
async function greenlightFailure(doFetch: Fetcher): Promise<string | null> {
  try {
    const res = await doFetch("/api/greenlight", { cache: "no-store" });
    const data = (await res.json()) as { ok?: boolean; error?: string };
    if (!res.ok || !data.ok) {
      return data.error || "The Nano network connection is unavailable.";
    }
    return null;
  } catch {
    return "We could not reach the BlackBird service.";
  }
}

export async function checkNetwork(
  doFetch: Fetcher = fetch,
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((r) => setTimeout(r, ms))
): Promise<GateState> {
  // /api/greenlight is the liveness probe: it proves rpc.nano.to answers and
  // the indexer is reachable right now. There is no fallback RPC node, so this
  // failing means the network genuinely cannot be used.
  //
  // But one failure is not an outage. rpc.nano.to rate-limits (HTTP 429), and
  // since removing the fallback node a single throttled request would otherwise
  // blank the entire app. Closing the app wrongly is worse than the delay of a
  // second attempt, so a failure must repeat before we believe it.
  let failure = await greenlightFailure(doFetch);
  if (failure) {
    await sleep(1500);
    failure = await greenlightFailure(doFetch);
    if (failure) return { kind: "down", reason: failure };
  }

  // Reachable is not the same as working. The hourly probe moves real XNO
  // through shield → index → prove → withdraw; if its last run failed, deposits
  // would get stuck even though every service answers.
  try {
    const res = await doFetch("/api/e2e_status", { cache: "no-store" });
    const data = (await res.json()) as { state?: string; failed_step?: string };
    if (data.state === "failing") {
      return {
        kind: "down",
        reason:
          "Our automatic end-to-end test moves real XNO through the privacy pool every hour, and the last run did not complete" +
          (data.failed_step ? ` (${data.failed_step})` : "") +
          ".",
      };
    }
  } catch {
    // The monitor's own availability is not a reason to close the app: the
    // liveness check above already passed.
  }

  return { kind: "up" };
}
