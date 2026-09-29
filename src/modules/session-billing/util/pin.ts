import { randomInt } from 'node:crypto';

import { hash, verify } from '@node-rs/argon2';

// @node-rs/argon2's Algorithm is an ambient `const enum`, which isolatedModules
// forbids referencing directly. 2 is Algorithm.Argon2id (also the library default).
const ARGON2ID = 2;

export const PIN_LENGTH = 6;

/** The station login PIN staff hand the gamer. Uniform over all 6-digit strings. */
export function generatePin(): string {
  return String(randomInt(0, 10 ** PIN_LENGTH)).padStart(PIN_LENGTH, '0');
}

/** Only this hash is stored; the plaintext PIN leaves the backend once, in the start() response. */
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
