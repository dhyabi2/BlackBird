import { z } from "zod";

export const nanoAddressSchema = z
  .string()
  .regex(/^nano_[13]{1}[13456789abcdefghijkmnopqrstuwxyz]{59}$/, "Invalid Nano address");

export const hexHashSchema = z
  .string()
  .regex(/^[0-9a-fA-F]{64}$/, "Invalid 64-character hex hash");

export const depositRequestSchema = z.object({
  deposit_hash: hexHashSchema,
  commit_hash: hexHashSchema,
});

const denominationSchema = z.union([
  z.string().regex(/^\d+$/, "Denomination must be a numeric string"),
  z.number().int().positive(),
]);

const snarkjsProofSchema = z.object({
  pi_a: z.array(z.string()),
  pi_b: z.array(z.array(z.string())),
  pi_c: z.array(z.string()),
  protocol: z.string().optional(),
});

export const withdrawRequestSchema = z.object({
  destination: nanoAddressSchema,
  epoch: z.number().int().nonnegative(),
  denomination: denominationSchema,
  nullifier: z.string().min(1, "nullifier is required"),
  proof: snarkjsProofSchema,
  publicSignals: z.array(z.string()).length(4),
});

export const proveRequestSchema = z.object({
  n: hexHashSchema,
  t: hexHashSchema,
  P_w: hexHashSchema,
  nullifier: z.string().min(1, "nullifier is required"),
  denomination: denominationSchema,
  epoch: z.number().int().nonnegative(),
  leaf_index: z.number().int().nonnegative().optional(),
});

export const balanceQuerySchema = z.object({
  account: nanoAddressSchema,
});
