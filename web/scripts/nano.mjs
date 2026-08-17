import nanoWeb from "nanocurrency-web";
import blakejs from "blakejs";
const { blake2bHex } = blakejs;

const { wallet, block, tools } = nanoWeb;

export const ZERO_HASH = "0".repeat(64);
export const SEND_THRESHOLD = "fffffff800000000";
export const RECEIVE_THRESHOLD = "fffffe0000000000";
export const DEFAULT_REP = "nano_3jwrszth46rk1mu7rmb4rhm54us8yg1gw3ipodftqtikf5yqdyr7471nsg1k";

const RPC_URL = "https://rpc.nano.to";
const RPC_KEY = process.env.NANO_RPC_KEY || "";
const RPC_TIMEOUT = 20000;
const RPC_RETRIES = 3;

export function ensureNanoPrefix(address) {
  if (address.startsWith("xrb_")) return "nano_" + address.slice(4);
  return address;
}

export function generateWallet(seed, index) {
  const account = wallet.legacyAccounts(seed, index, index + 1)[0];
  return {
    seed,
    index,
    secretKey: account.privateKey.toUpperCase(),
    publicKey: account.publicKey.toUpperCase(),
    address: account.address,
  };
}

export function publicKeyToAddress(publicKey) {
  const clean = String(publicKey).replace(/^0x/, "").toUpperCase();
  return tools.publicKeyToAddress(clean);
}

export function addressToPublicKey(address) {
  return tools.addressToPublicKey(ensureNanoPrefix(address));
}

export function linkToAddress(link) {
  if (link.startsWith("nano_") || link.startsWith("xrb_")) {
    return ensureNanoPrefix(link);
  }
  const clean = String(link).replace(/^0x/, "").toUpperCase();
  return tools.publicKeyToAddress(clean);
}

export function rawToNano(raw) {
  return tools.convert(String(raw), "RAW", "NANO");
}

export function nanoToRaw(nano) {
  return tools.convert(String(nano), "NANO", "RAW");
}

function hexToBytes(hex) {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new Error("Invalid hex length");
  return new Uint8Array(clean.match(/.{1,2}/g).map((b) => parseInt(b, 16)));
}

function rawTo16Bytes(raw) {
  let value = BigInt(raw);
  const bytes = new Uint8Array(16);
  for (let i = 15; i >= 0; i--) {
    bytes[i] = Number(value & 0xffn);
    value >>= 8n;
  }
  return bytes;
}

export function stateBlockHash(signed) {
  // Nano state block hash prefix: 32 bytes, last byte = 0x06
  const prefix = new Uint8Array(32);
  prefix[31] = 6;
  const account = hexToBytes(addressToPublicKey(String(signed.account)));
  const previous = hexToBytes(String(signed.previous));
  const representative = hexToBytes(addressToPublicKey(String(signed.representative)));
  const balance = rawTo16Bytes(String(signed.balance));
  const link = hexToBytes(String(signed.link));
  const payload = new Uint8Array(
    prefix.length + account.length + previous.length + representative.length + balance.length + link.length
  );
  let offset = 0;
  payload.set(prefix, offset);
  offset += prefix.length;
  payload.set(account, offset);
  offset += account.length;
  payload.set(previous, offset);
  offset += previous.length;
  payload.set(representative, offset);
  offset += representative.length;
  payload.set(balance, offset);
  offset += balance.length;
  payload.set(link, offset);
  return blake2bHex(payload, undefined, 32).toUpperCase();
}

export function buildSendBlock(secretKey, { fromAddress, previous, representative, balance, link, amount, work }) {
  const previousBalance = (BigInt(balance) + BigInt(amount)).toString();
  const signed = block.send(
    {
      walletBalanceRaw: previousBalance,
      fromAddress,
      toAddress: linkToAddress(link),
      representativeAddress: ensureNanoPrefix(representative),
      frontier: previous,
      amountRaw: amount,
      work,
    },
    secretKey.toLowerCase()
  );
  return { hash: stateBlockHash(signed), block: signed };
}

export function buildReceiveBlock(
  secretKey,
  { toAddress, previous, representative, transactionHash, balance, amount, work }
) {
  const signed = block.receive(
    {
      walletBalanceRaw: previous === ZERO_HASH ? "0" : balance,
      toAddress,
      representativeAddress: ensureNanoPrefix(representative),
      frontier: previous,
      transactionHash,
      amountRaw: amount,
      work,
    },
    secretKey.toLowerCase()
  );
  return { hash: stateBlockHash(signed), block: signed };
}

export async function rpcCall(action, params = {}) {
  const body = JSON.stringify({ action, ...params });
  const headers = { "Content-Type": "application/json" };
  if (RPC_KEY) headers.Authorization = RPC_KEY;

  let lastError;
  for (let attempt = 1; attempt <= RPC_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), RPC_TIMEOUT);
    try {
      const response = await fetch(RPC_URL, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
      const data = await response.json();
      if (data.error && data.error !== "Account not found") throw new Error(data.error);
      return data;
    } catch (err) {
      lastError = err.name === "AbortError" ? new Error(`RPC timeout (${RPC_TIMEOUT}ms)`) : err;
      console.warn(`[Nano] RPC ${RPC_URL} attempt ${attempt}/${RPC_RETRIES} failed:`, lastError.message);
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError || new Error("All RPC attempts failed");
}

export async function fetchAccountHistory(account, { count = 100, raw = false } = {}) {
  const result = await rpcCall("account_history", { account, count, raw: raw ? "true" : undefined });
  return result.history || [];
}

export function workHashForReceive(previous, publicKey) {
  return previous === ZERO_HASH ? publicKey : previous;
}
