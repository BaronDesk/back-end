import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, randomInt } from 'node:crypto';

import { hash, verify } from '@node-rs/argon2';

// @node-rs/argon2's Algorithm is an ambient `const enum`, which isolatedModules
// forbids referencing directly. 2 is Algorithm.Argon2id (also the library default).
const ARGON2ID = 2;

export const PIN_LENGTH = 6;

/** The station login PIN, shown in the gamer's app. Uniform over all 6-digit strings. */
export function generatePin(): string {
  return String(randomInt(0, 10 ** PIN_LENGTH)).padStart(PIN_LENGTH, '0');
}

/** What login checks against. The PIN is also kept encrypted (PinVault) so the app can show it again. */
export function hashPin(pin: string): Promise<string> {
  return hash(pin, { algorithm: ARGON2ID });
}

/** A malformed stored hash counts as a mismatch, never an error. */
export async function verifyPin(pinHash: string, candidate: string): Promise<boolean> {
  try {
    return await verify(pinHash, candidate);
  } catch {
    return false;
  }
}

const SEALED_PREFIX = 'v1';

/**
 * Keeps a PIN recoverable for its owner: AES-256-GCM with a key derived
 * (HKDF-SHA256) from a server secret. Sealed form: `v1:<iv>:<tag>:<ciphertext>`,
 * base64url parts. A database dump alone reveals no PIN, and a PIN is only
 * usable on its PC during its booking anyway.
 */
export class PinVault {
  private readonly key: Buffer;

  constructor(secret: string) {
    this.key = Buffer.from(hkdfSync('sha256', secret, 'barondesk', 'station-pin-v1', 32));
  }

  seal(pin: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(pin, 'utf8'), cipher.final()]);
    return [SEALED_PREFIX, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), data.toString('base64url')].join(':');
  }

  /** The PIN, or null for anything tampered with or sealed under another key. */
  open(sealed: string | null | undefined): string | null {
    const parts = sealed?.split(':');
    if (!parts || parts.length !== 4 || parts[0] !== SEALED_PREFIX) return null;
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(parts[1], 'base64url'));
      decipher.setAuthTag(Buffer.from(parts[2], 'base64url'));
      return Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64url')), decipher.final()]).toString('utf8');
    } catch {
      return null;
    }
  }
}
