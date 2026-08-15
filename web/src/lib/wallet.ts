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

  // Ensure account field uses nano_ prefix
  const account = String(block.block.account);
  if (account.startsWith("xrb_")) {
    block.block.account = "nano_" + account.slice(4);
  }

  return block;
}

export { deriveAddress, derivePublicKey };
