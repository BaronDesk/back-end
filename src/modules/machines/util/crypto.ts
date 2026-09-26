import { createHash, randomBytes } from 'node:crypto';

/** One-time enrollment secret handed to a station out-of-band (QR code, USB drop, etc.). */
export function generateEnrollmentToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Only this hash is ever persisted (see EnrollmentToken.tokenHash). Redemption
 * looks a row up by the hash of the presented token — a plain unique-index
 * lookup, not a compare-many-and-check loop, so there's nothing here for a
 * timing attack to learn: a wrong guess costs the same "not found" either way,
 * and finding a preimage of a specific sha256 output isn't feasible regardless
 * of timing.
 */
export function hashEnrollmentToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
