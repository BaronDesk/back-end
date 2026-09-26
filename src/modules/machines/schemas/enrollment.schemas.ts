import { z } from 'zod';

export const issueEnrollmentTokenSchema = z.object({
  branchId: z.string().uuid(),
  // Caller-chosen TTL; capped at 24h server-side regardless of what's sent.
  ttlMinutes: z.coerce.number().int().positive().max(1440).optional(),
});
export type IssueEnrollmentTokenDto = z.infer<typeof issueEnrollmentTokenSchema>;

// Same shape whether the station is enrolling fresh or rotating its
// credential — the token itself (looked up server-side) decides which.
// serialNumber is always required so a rotation redemption can be checked
// against the machine the token was actually minted for.
export const redeemEnrollmentTokenSchema = z.object({
  token: z.string().min(20),
  serialNumber: z.string().min(1).max(128),
  agentPublicKey: z.string().min(1),
  name: z.string().min(1).max(128).optional(),
});
export type RedeemEnrollmentTokenDto = z.infer<typeof redeemEnrollmentTokenSchema>;
