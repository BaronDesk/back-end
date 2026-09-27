export interface WalletRecord {
  id: string;
  gamerProfileId: string;
  balance: number;
  updatedAt: Date;
}

export interface LedgerEntryRecord {
  id: string;
  walletId: string;
  amount: number;
  balanceAfter: number;
  type: string;
  sessionId: string | null;
  createdAt: Date;
}


export function toPublicWallet(wallet: WalletRecord) {
  return {
    id: wallet.id,
    gamerProfileId: wallet.gamerProfileId,
    balance: wallet.balance,
    updatedAt: wallet.updatedAt,
  };
}

export function toPublicEntry(entry: LedgerEntryRecord) {
  return {
    id: entry.id,
    walletId: entry.walletId,
    amount: entry.amount,
    balanceAfter: entry.balanceAfter,
    type: entry.type,
    sessionId: entry.sessionId,
    createdAt: entry.createdAt,
  };
}
