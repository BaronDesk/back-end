export interface ResponseExample {
  /** Defaults to the route's normal success status. */
  status?: number;
  description?: string;
  body: unknown;
}

const USER_ID = '8d1f6a52-3c0b-4a77-b5de-91e0c2f47a10';
const GAMER_ID = '5b9e2d14-6f83-4c1a-8e27-d0a4b7c93f56';
const BRANCH_ID = '1c7a9e30-52bd-4f68-a3e1-7b0d4c8f2a95';
const MACHINE_ID = '3f2b8c1e-7a4d-4e5b-9c61-0d2f8a9b1c34';
const RESERVATION_ID = 'a4e6b1d8-90c2-4f35-8b7a-2e5d1c6f9034';
const SESSION_ID = 'c92f0a7b-1d48-4e63-b5a9-6f3e8d2c1b07';
const WALLET_ID = 'e07d3b95-4a1c-4268-9f50-b8c6a2d1e473';

const tokens = { accessToken: 'eyJhbGciOiJIUzI1NiIs...', refreshToken: 'eyJhbGciOiJIUzI1NiIs...' };

const publicUser = {
  id: USER_ID,
  username: 'gamer01',
  role: 'GAMER',
  accountStatus: 'ACTIVE',
  branchId: null,
  gamerProfileId: GAMER_ID,
  homeBranchId: BRANCH_ID,
  avatarUrl: null,
  createdAt: '2026-05-20T09:30:00.000Z',
};

const BADGE_URL = '/uploads/images/9b3e5f71-2c8d-4a06-b4e9-5d1a7c0f2e68.webp';
const AVATAR_URL = '/uploads/avatars/6d2a8e14-73fb-4c95-a0d8-1e4b9f5c3a27.webp';
const rank = { id: 'f1a7c3e9-5b2d-4806-9e4f-a3c1d7b5e290', name: 'Gold', minXp: 4000, badgeUrl: BADGE_URL, createdAt: '2026-05-20T09:30:00.000Z', updatedAt: '2026-05-20T09:30:00.000Z' };

const reservation = {
  id: RESERVATION_ID,
  gamerProfileId: GAMER_ID,
  machineId: MACHINE_ID,
  startTime: '2026-06-01T18:00:00.000Z',
  endTime: '2026-06-01T19:00:00.000Z',
  status: 'CONFIRMED',
  isWalkIn: false,
  createdAt: '2026-05-31T12:00:00.000Z',
  updatedAt: '2026-05-31T12:00:00.000Z',
};

const checkIn = {
  sessionId: SESSION_ID,
  reservationId: RESERVATION_ID,
  pin: '482913',
  pinExpiresAt: '2026-06-01T18:30:00.000Z',
};

const walletEntry = {
  id: 'f1b8c4a2-7d35-4e90-a6b3-2c9e5d0a8147',
  walletId: WALLET_ID,
  amount: 15000,
  balanceAfter: 15000,
  type: 'CREDIT',
  sessionId: null,
  createdAt: '2026-05-31T11:45:00.000Z',
};

const pricing = { paygRate: 4000, bookingRate: 4000, updatedAt: '2026-05-31T11:45:00.000Z' };

/**
 * Hand-written success bodies for the demo flow, keyed by `Controller_method`.
 * The request side comes from the Zod schemas automatically; responses are
 * plain objects returned by services, so they need an example here.
 * Money is whole coins (1000 coins = 1 DT in Tunisia); rates are coins per hour.
 */
export const RESPONSE_EXAMPLES: Record<string, ResponseExample> = {
  AuthController_login: { body: tokens },
  AuthController_refresh: { body: tokens },
  AuthController_logout: { body: { success: true } },
  AuthController_changePassword: { body: tokens },
  AuthController_me: { body: publicUser },

  UsersController_createGamer: { description: 'Gamer account created', body: publicUser },
  UsersController_setAvatar: { description: 'The gamer, with the new picture', body: { ...publicUser, avatarUrl: AVATAR_URL } },
  UsersController_removeAvatar: { body: publicUser },

  UploadsController_uploadImage: { description: 'Stored; save this link as a badgeUrl or iconUrl', body: { url: BADGE_URL } },
  RanksController_list: { body: [{ ...rank, name: 'Wood', minXp: 0 }, rank] },
  RanksController_create: { body: rank },
  RanksController_update: { body: rank },
  RanksController_remove: { body: { id: rank.id, deleted: true } },

  ReservationsController_list: { body: [{ ...reservation, pin: null }] },
  ReservationsController_create: {
    description: 'Booking created; checkIn holds the PIN to type at the station (null if none could be issued)',
    body: { ...reservation, checkIn },
  },
  ReservationsController_walkIn: {
    description: 'Play now: the booking starts at once',
    body: { ...reservation, isWalkIn: true, status: 'ACTIVE', checkIn },
  },
  ReservationsController_checkIn: { description: 'A fresh PIN for this booking', body: checkIn },
  ReservationsController_cancel: { body: { ...reservation, status: 'CANCELLED' } },

  WalletController_getMyWallet: {
    body: { id: WALLET_ID, gamerProfileId: GAMER_ID, balance: 15000, updatedAt: '2026-05-31T11:45:00.000Z' },
  },
  WalletController_getMyEntries: { body: [walletEntry] },
  WalletController_credit: { description: 'Top-up recorded', body: walletEntry },

  PricingController_get: { description: 'Coins per hour, the same in every branch', body: pricing },
  PricingController_upsert: { description: 'Saved for every branch', body: pricing },
};
