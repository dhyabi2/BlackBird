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

export const withdrawRequestSchema = z.object({
  destination: nanoAddressSchema,
  epoch: z.number().int().nonnegative(),
  denomination: z.number().int().positive(),
  nullifier: z.string().min(1, "nullifier is required"),
  proof: z.any(),
  publicSignals: z.array(z.string()),
});

export const proveRequestSchema = z.object({
  inputs: z.record(z.string(), z.any()),
});

export const balanceQuerySchema = z.object({
  account: nanoAddressSchema,
});
