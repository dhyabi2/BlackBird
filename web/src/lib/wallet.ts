import { wallet, block, tools } from "nanocurrency-web";
import { blake2b } from "blakejs";

export type NanoBlock = {
  hash: string;
  block: Record<string, unknown>;
};

const ZERO_HASH = "0000000000000000000000000000000000000000000000000000000000000000";

function ensureNanoPrefix(address: string): string {
  if (address.startsWith("xrb_")) return "nano_" + address.slice(4);
  return address;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new Error("Invalid hex length");
  return new Uint8Array(clean.match(/.{1,2}/g)!.map((b) => parseInt(b, 16)));
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function addressToBytes(address: string): Uint8Array {
  return hexToBytes(tools.addressToPublicKey(ensureNanoPrefix(address)));
}

function rawTo16Bytes(raw: string): Uint8Array {
  let value = BigInt(raw);
  const bytes = new Uint8Array(16);
  for (let i = 15; i >= 0; i--) {
    bytes[i] = Number(value & 0xffn);
    value >>= 8n;
  }
  return bytes;
}

function linkToAddress(link: string): string {
  // nanocurrency-web block.send wants a Nano address as the recipient.
  // If the caller already passed an address, use it directly. Otherwise treat
  // `link` as a 64-character public key and encode it as a Nano address.
  if (link.startsWith("nano_") || link.startsWith("xrb_")) {
    return ensureNanoPrefix(link);
  }
  const clean = link.replace(/^0x/, "").toUpperCase();
  if (!/^[0-9A-F]{64}$/.test(clean)) {
    throw new Error("Invalid link: expected a nano address or 64-character hex public key");
  }
  return tools.publicKeyToAddress(clean);
}

function stateBlockHash(block: {
  account: string;
  previous: string;
  representative: string;
  balance: string;
  link: string;
}): string {
  // Nano state block hash = BLAKE2b-256(
  //   32-byte header (0x00..0x06) || account || previous || representative || balance(16BE) || link
  // )
  const prefix = new Uint8Array(32);
  prefix[31] = 6;
  const account = addressToBytes(block.account);
  const previous = hexToBytes(block.previous);
  const representative = addressToBytes(block.representative);
  const balance = rawTo16Bytes(block.balance);
  const link = hexToBytes(block.link);

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

  return bytesToHex(blake2b(payload, undefined, 32)).toUpperCase();
}

export function deriveLegacyAccount(seedHex: string, index: number) {
  // nanocurrency-web uses lowercase hex; keep the rest of the app consistent
  // with the uppercase formatting used by the original nanocurrency toolkit.
  const accounts = wallet.legacyAccounts(seedHex, index, index + 1);
  const account = accounts[0];
  return {
    secretKey: account.privateKey.toUpperCase(),
    publicKey: account.publicKey.toUpperCase(),
    address: account.address,
    index,
  };
}

export function buildSendBlock(
  secretKey: string,
  data: {
    fromAddress: string;
    previous: string;
    representative: string;
    balance: string;
    link: string;
    amount: string;
    work: string;
  }
): NanoBlock {
  const previousBalance = (BigInt(data.balance) + BigInt(data.amount)).toString();
  const signed = block.send(
    {
      walletBalanceRaw: previousBalance,
      fromAddress: data.fromAddress,
      toAddress: linkToAddress(data.link),
      representativeAddress: ensureNanoPrefix(data.representative),
      frontier: data.previous,
      amountRaw: data.amount,
      work: data.work,
    },
    secretKey.toLowerCase()
  );
  return {
    hash: stateBlockHash({
      account: String(signed.account),
      previous: String(signed.previous),
      representative: String(signed.representative),
      balance: String(signed.balance),
      link: String(signed.link),
    }),
    block: signed,
  };
}

export function buildReceiveBlock(
  secretKey: string,
  data: {
    toAddress: string;
    previous: string;
    representative: string;
    transactionHash: string;
    balance: string;
    amount: string;
    work: string;
  }
): NanoBlock {
  const signed = block.receive(
    {
      walletBalanceRaw: data.previous === ZERO_HASH ? "0" : data.balance,
      toAddress: data.toAddress,
      representativeAddress: ensureNanoPrefix(data.representative),
      frontier: data.previous,
      transactionHash: data.transactionHash,
      amountRaw: data.amount,
      work: data.work,
    },
    secretKey.toLowerCase()
  );
  return {
    hash: stateBlockHash({
      account: String(signed.account),
      previous: String(signed.previous),
      representative: String(signed.representative),
      balance: String(signed.balance),
      link: String(signed.link),
    }),
    block: signed,
  };
}

export function publicKeyToAddress(publicKey: string): string {
  const clean = publicKey.replace(/^0x/, "").toUpperCase();
  return tools.publicKeyToAddress(clean);
}

export function rawToNano(raw: string): string {
  return tools.convert(raw, "RAW", "NANO");
}

export function nanoToRaw(nano: string): string {
  return tools.convert(nano, "NANO", "RAW");
}
