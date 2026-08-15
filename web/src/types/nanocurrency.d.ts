declare module "nanocurrency" {
  export function deriveSecretKey(seed: string, index: number): string;
  export function derivePublicKey(secretKey: string): string;
  export function deriveAddress(
    publicKey: string,
    options?: { useNanoPrefix?: boolean }
  ): string;
  export function createBlock(
    secretKey: string,
    data: {
      work: string;
      previous: string;
      representative: string;
      balance: string;
      link: string;
    }
  ): { hash: string; block: Record<string, unknown> };
  export function convert(
    value: string | number,
    params: { from: string; to: string }
  ): string;
  export enum Unit {
    hex = "hex",
    raw = "raw",
    nano = "nano",
    knano = "knano",
    Nano = "Nano",
    NANO = "NANO",
    KNano = "KNano",
    MNano = "MNano",
  }
}
