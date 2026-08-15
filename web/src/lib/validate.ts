import { z } from "zod";

export const nanoAddressSchema = z
  .string()
  .regex(/^nano_[13]{1}[13456789abcdefghijkmnopqrstuwxyz]{59}$/, "Invalid Nano address");

export const depositRequestSchema = z.object({
  account: nanoAddressSchema,
  amountRaw: z.string().regex(/^\d+$/, "amountRaw must be a non-negative integer string"),
  commitment: z.string().regex(/^(0x)?[0-9a-fA-F]+$/, "Invalid commitment hex"),
});

export const withdrawRequestSchema = z.object({
  nullifier: z.string().min(1, "nullifier is required"),
  proof: z.any(),
  publicSignals: z.array(z.string()),
  destination: nanoAddressSchema,
});

export const proveRequestSchema = z.object({
  inputs: z.record(z.string(), z.any()),
});

export const balanceQuerySchema = z.object({
  account: nanoAddressSchema,
});
