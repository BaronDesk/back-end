import { z } from 'zod';

export const issueEnrollmentTokenSchema = z.object({
  branchId: z.string().uuid(),
  ttlMinutes: z.coerce.number().int().positive().max(1440).optional(),
});
export type IssueEnrollmentTokenDto = z.infer<typeof issueEnrollmentTokenSchema>;


export const redeemEnrollmentTokenSchema = z.object({
  oneTimeToken: z.string().min(20),
  serialNumber: z.string().min(1).max(128),
  machineName: z.string().min(1).max(128),
  agentVersion: z.string().min(1).max(128),
  agentPublicKey: z.string().min(1),
  mac: z.string().min(1).max(128),
  ip: z.string().min(1).max(128),
  signedAt: z.union([z.number().int().positive(), z.string().min(1)]),
  signature: z.string().min(1),
});
export type RedeemEnrollmentTokenDto = z.infer<typeof redeemEnrollmentTokenSchema>;
