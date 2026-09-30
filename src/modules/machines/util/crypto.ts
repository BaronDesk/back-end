import { createHash, randomBytes } from 'node:crypto';


export function generateEnrollmentToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashEnrollmentToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
