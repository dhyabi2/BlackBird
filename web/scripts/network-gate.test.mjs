/**
 * Tests the MaintenanceGate decision: when does BlackBird replace the whole app
 * with a maintenance screen?
 *
 * The asymmetry here is the point. Closing the app when it should stay open
 * blocks people from their own funds; leaving it open when the pipeline is
 * broken strands deposits. So a *protocol* failure closes the app, while the
 * monitor's own problems (unfunded probe wallet, unreachable status endpoint)
 * must not.
 *
 *   node --experimental-strip-types scripts/network-gate.test.mjs
 */
import { checkNetwork } from "../src/lib/network-gate.ts";
const noSleep = async () => {};

// `routes` values may be an array: one entry per successive call to that URL,
// which is how the retry-once behaviour gets exercised.
const stub = (routes) => {
  const calls = {};
  const f = async (url) => {
    calls[url] = (calls[url] ?? 0) + 1;
    const entry = routes[url];
    const r = Array.isArray(entry) ? entry[Math.min(calls[url] - 1, entry.length - 1)] : entry;
    if (!r || r.throw) throw new Error("network error");
    return { ok: r.ok !== false, json: async () => r.body };
  };
  f.calls = calls;
  return f;
};

const cases = [
  ["everything healthy", { "/api/greenlight": { body: { ok: true } }, "/api/e2e_status": { body: { state: "ok" } } }, "up"],
  ["rpc.nano.to down (greenlight error)", { "/api/greenlight": { ok: false, body: { error: "Nano RPC error: 429" } }, "/api/e2e_status": { body: { state: "ok" } } }, "down"],
  ["backend unreachable (fetch throws)", { "/api/greenlight": { throw: true } }, "down"],
  ["probe failing at protocol step", { "/api/greenlight": { body: { ok: true } }, "/api/e2e_status": { body: { state: "failing", failed_step: "shield_and_withdraw" } } }, "down"],
  ["probe monitor unfunded (unknown)", { "/api/greenlight": { body: { ok: true } }, "/api/e2e_status": { body: { state: "unknown" } } }, "up"],
  ["probe stale but services live", { "/api/greenlight": { body: { ok: true } }, "/api/e2e_status": { body: { state: "stale" } } }, "up"],
  ["status monitor itself unreachable", { "/api/greenlight": { body: { ok: true } }, "/api/e2e_status": { throw: true } }, "up"],
  // A single 429 from rpc.nano.to must NOT blank the app: with no fallback node,
  // one throttled request would otherwise look like a total outage.
  ["transient 429, recovers on retry", { "/api/greenlight": [{ ok: false, body: { error: "Nano RPC error: 429" } }, { body: { ok: true } }], "/api/e2e_status": { body: { state: "ok" } } }, "up"],
  ["sustained 429 across both tries", { "/api/greenlight": [{ ok: false, body: { error: "Nano RPC error: 429" } }, { ok: false, body: { error: "Nano RPC error: 429" } }], "/api/e2e_status": { body: { state: "ok" } } }, "down"],
];

let fail = 0;
for (const [name, routes, want] of cases) {
  const got = await checkNetwork(stub(routes), noSleep);
  const ok = got.kind === want;
  if (!ok) fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(38)} want=${want} got=${got.kind}${got.reason ? `  "${got.reason.slice(0, 52)}..."` : ""}`);
}
console.log(fail ? `\n${fail} FAILED` : "\nall passed");
process.exit(fail ? 1 : 0);
