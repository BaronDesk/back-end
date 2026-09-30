import type { Prisma } from '../../generated/prisma/index.js';

/** 1 dinar = 1000 millimes. Every Int money column (wallets, ledger, pricing, sessions) is millimes. */
export const MILLIMES_PER_DINAR = 1000;

/** A Decimal dinar amount (plan prices) as integer millimes, the unit the wallet charges in. */
export function dinarsToMillimes(dinars: Prisma.Decimal | number): number {
  return Math.round(Number(dinars) * MILLIMES_PER_DINAR);
}
