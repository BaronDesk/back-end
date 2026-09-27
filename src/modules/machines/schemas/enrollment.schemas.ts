import { z } from 'zod';

export const issueEnrollmentTokenSchema = z.object({
  branchId: z.string().uuid(),
  ttlMinutes: z.coerce.number().int().positive().max(1440).optional(),
});
export type IssueEnrollmentTokenDto = z.infer<typeof issueEnrollmentTokenSchema>;


export const redeemEnrollmentTokenSchema = z.object({
  token: z.string().min(20),
  serialNumber: z.string().min(1).max(128),
  agentPublicKey: z.string().min(1),
  name: z.string().min(1).max(128).optional(),
});
export type RedeemEnrollmentTokenDto = z.infer<typeof redeemEnrollmentTokenSchema>;
