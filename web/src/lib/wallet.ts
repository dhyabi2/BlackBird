import {
  deriveAddress,
  derivePublicKey,
  deriveSecretKey,
  createBlock,
} from "nanocurrency";

export type NanoBlock = {
  hash: string;
  block: Record<string, unknown>;
};

export function deriveLegacyAccount(seedHex: string, index: number) {
  const secretKey = deriveSecretKey(seedHex, index);
  const publicKey = derivePublicKey(secretKey);
  const address = deriveAddress(publicKey, { useNanoPrefix: true });
  return { secretKey, publicKey, address, index };
}

export function validateSeed(seedHex: string): boolean {
  return /^[0-9a-fA-F]{64}$/.test(seedHex);
}

function ensureNanoPrefix(address: string): string {
  if (address.startsWith("xrb_")) return "nano_" + address.slice(4);
  return address;
}

function cleanBlock(
  block: Record<string, unknown>,
  subtype: "send" | "receive" | "open" | "change"
): Record<string, unknown> {
  const cleaned = { ...block };
  delete cleaned.link_as_account;
  cleaned.account = ensureNanoPrefix(String(cleaned.account));
  if (cleaned.representative) {
    cleaned.representative = ensureNanoPrefix(String(cleaned.representative));
  }
  cleaned.subtype = subtype;
  return cleaned;
}

export function buildSendBlock(
  secretKey: string,
  data: {
    previous: string;
    representative: string;
    balance: string;
    link: string;
    work: string;
  }
): NanoBlock {
  const block = createBlock(secretKey, {
    work: data.work,
    previous: data.previous,
    representative: data.representative,
    balance: data.balance,
    link: data.link,
  });
  return { hash: block.hash, block: cleanBlock(block.block, "send") };
}

export function buildReceiveBlock(
  secretKey: string,
  data: {
    previous: string;
    representative: string;
    balance: string;
    link: string;
    work: string;
  }
): NanoBlock {
  const isOpen =
    data.previous === "0000000000000000000000000000000000000000000000000000000000000000";
  const block = createBlock(secretKey, {
    work: data.work,
    previous: data.previous,
    representative: data.representative,
    balance: data.balance,
    link: data.link,
  });
  return {
    hash: block.hash,
    block: cleanBlock(block.block, isOpen ? "open" : "receive"),
  };
}

export { deriveAddress, derivePublicKey };
