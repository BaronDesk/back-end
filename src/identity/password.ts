import { Algorithm, hash, verify } from "@node-rs/argon2";

const CONFIG = {
  memorySize: 65536, // 64 MB
  passes: 3,         // Iterations
  parallelism: 4,    // Threads
  outputLen: 32,     // Output hash length
};

/**
 * Hashes a plain text password using Argon2id and returns a PHC string.
 */
export async function hashPassword(password: string): Promise<string> {
  return hash(password, {
    algorithm: Algorithm.Argon2id,
    memoryCost: CONFIG.memorySize,
    timeCost: CONFIG.passes,
    parallelism: CONFIG.parallelism,
    outputLen: CONFIG.outputLen,
  });
}

/**
 * Verifies a plain text password against a stored Argon2id PHC string.
 */
export async function verifyPassword(storedHash: string, plainText: string): Promise<boolean> {
  try {
    return await verify(storedHash, plainText);
  } catch {
    return false;
  }
}
