import * as nano from "nanocurrency";

const BASE_URL = process.env.VELA_BASE_URL || "https://velav2-web.vercel.app";
const ZERO_HASH = "0".repeat(64);
const RECEIVE_THRESHOLD = "fffffe0000000000";

const seed = "308095e652ffaf2b79da3337a4847b3656f09d8d3d8337557f62d9be593e3edc";
const secretKey = nano.deriveSecretKey(seed, 0);
const publicKey = nano.derivePublicKey(secretKey);
const address = nano.deriveAddress(publicKey, { useNanoPrefix: true });

const pendingHashes = [
  "33030B3721883AD033308C5C174DE6426E16E2571C9F8A96CD15DB000FB631BE",
  "2CFAF31954CFF5D6EE6280DECB259B7C985FAEF31DF7B2F17422A6C87636FBE0",
  "2DCF4C94C30DDAE38E94EABF6ADA154E85F378EEA27322F3C3095F41CDCBC6D0",
  "8448EBF397609B5908FD5753761F3EE78299A4CAAEA35833522350BADC4C2B6A",
  "BFA44E024CDD5E525BB93C404E4C744FAC6B589CF88DD591C48445697CF327A0",
];

const amount = 99999999999999999999999999999n;

async function apiPost(path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `POST ${path} failed: ${res.status}`);
  return data;
}

async function computeWork(hash, threshold) {
  return nano.computeWork(hash, { workThreshold: threshold });
}

function buildBlock(sk, { previous, representative, balance, link, work }) {
  const block = nano.createBlock(sk, { work, previous, representative, balance, link });
  const cleaned = { ...block.block };
  delete cleaned.link_as_account;
  cleaned.account = address;
  cleaned.representative = representative;
  return { hash: block.hash, block: cleaned };
}

let previous = ZERO_HASH;
let balance = 0n;
for (let i = 0; i < pendingHashes.length; i++) {
  const link = pendingHashes[i];
  const workHash = previous === ZERO_HASH ? publicKey : previous;
  const work = await computeWork(workHash, RECEIVE_THRESHOLD);
  const newBalance = (balance + amount).toString();
  const block = buildBlock(secretKey, {
    previous,
    representative: address,
    balance: newBalance,
    link,
    work,
  });
  console.log(`Receive ${i + 1}/${pendingHashes.length}: ${block.hash}`);
  await apiPost("/api/broadcast", { block: block.block });
  previous = block.hash;
  balance = BigInt(newBalance);
}
console.log(`Guardian ${address} opened with balance ${balance} raw`);
