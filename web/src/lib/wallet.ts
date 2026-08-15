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

  const cleaned = { ...block.block };
  // link_as_account is not a standard state-block field for process
  delete cleaned.link_as_account;
  cleaned.account = ensureNanoPrefix(String(cleaned.account));
  cleaned.representative = ensureNanoPrefix(String(cleaned.representative));

  return { hash: block.hash, block: cleaned };
}

export { deriveAddress, derivePublicKey };
