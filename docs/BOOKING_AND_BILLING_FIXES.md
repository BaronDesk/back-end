# Booking and billing flow fixes

This note records the backend changes made on 2026-09-30 to the booking,
check-in, billing, wallet and plan flows. Each section gives the problem, what
changed and where. Read it before touching `reservations`, `session-billing`,
`wallet`, `membership` or `subscriptions`.

> **Later changes:** `FLOW_FIXES.md` (2026-10-01) changes several rules here. The PIN now
> comes with the booking and works from its start; the balance is checked at booking and at
> login; a no-show comes 30 minutes after the start; and gamers have a home branch. Where the
> two notes differ, `FLOW_FIXES.md` wins.

---

## 0. Before you run it

- **Migration:** `prisma/migrations/20260930170000_walk_in_and_lock_reason`
  adds two columns. Apply it, then restart the backend:

  ```sh
  npx prisma migrate deploy
  ```

  | Table          | Column        | Type                    | Meaning                                              |
  |----------------|---------------|-------------------------|------------------------------------------------------|
  | `reservations` | `is_walk_in`  | `BOOLEAN NOT NULL DEFAULT false` | Play now (walk-in rate) vs booked ahead (booking rate) |
  | `sessions`     | `lock_reason` | `TEXT NULL`             | `"runout"` when the backend locked the station because the funds ran out |

  Reservations that existed before the migration count as booked ahead.

- **New settings** in `src/config/env.schema.ts`. Both have defaults, so
  `.env` needs no change.

  | Variable                   | Default        | Meaning                                                   |
  |----------------------------|----------------|-----------------------------------------------------------|
  | `SESSION_MIN_PLAY_MINUTES` | `5`            | A PIN is only issued when the balance covers this many minutes of play |
  | `BUSINESS_TIMEZONE`        | `Africa/Tunis` | Pass time windows ("00:00–06:00") are read in this time zone |

- **Seed:** the subscription plans' `benefits` were converted to the
  `windows` shape the API accepts (see §4). Re-seeding updates existing plans.

---

## 1. The gamer gets the PIN, not the desk

**Problem.** A booking gave the gamer a booking code (the reservation id). The
gamer had to show it at the desk, staff pasted it into the dashboard, and the
dashboard showed staff the PIN to read out. Two manual hand-offs for something
the backend can do by itself.

**Change.**

- New endpoint **`POST /reservations/:id/check-in`** (scope `self`, the
  gamer's own bookings only). It creates the PENDING session and answers with
  the PIN:

  ```json
  { "sessionId": "…", "reservationId": "…", "pin": "482913", "pinExpiresAt": "…" }
  ```

  - It opens 15 minutes before the booking (`RESERVATION_NOT_STARTED` before that).
  - Another gamer's booking is a 404 (`RESERVATION_NOT_FOUND`).
  - Asking again replaces a PIN nobody has typed yet, so a lost PIN is never a
    dead end. Once the PIN has been used, the answer is `SESSION_ALREADY_STARTED`.
- **`POST /reservations/walk-in`** (Play now) checks in at once: its answer is
  the reservation plus `checkIn` (the object above). If the PIN can't be issued
  (e.g. the PC went offline), the booking is kept, `checkIn` is `null`, and the
  gamer can call check-in again.
- The staff endpoint `POST /sessions` still exists as a fallback. It shares
  all the checks with check-in (same private `issuePin`), but no screen uses it
  any more.

**Where.** `session-billing/services/sessions.service.ts` (`checkIn`,
`issuePin`), `reservations/reservations.controller.ts`,
`reservations/reservations.service.ts`. `ReservationsModule` now imports
`SessionBillingModule`.

---

## 2. A session that ran out of money was billed nothing

**Problem.** At settlement the backend tried to take the whole bill from the
wallet. If the bill was even one millime more than the balance, the ledger
refused the debit, nothing was taken, and the session was only flagged
`debitFailed`. The runout lock always lands a few seconds after the money runs
out, so this was the normal case for anyone who played until empty.

**Change.** New `WalletService.debitUpTo()` (repository
`postCappedDebit()`). It locks the wallet row, takes
`min(bill, balance)` as one ledger entry, and returns the amount taken.
Settlement uses it and records:

| `billingBreakdown` field | Meaning                                           |
|--------------------------|---------------------------------------------------|
| `totalCents`             | The bill                                          |
| `chargedCents`           | What the wallet paid                              |
| `shortfallCents`         | The unpaid rest, present only when > 0            |
| `debitFailed`            | Still set if the charge threw an error            |

The idempotency key (`session-settlement:<sessionId>`) is unchanged, so a
repeated settlement never charges twice.

**Where.** `wallet/repository/wallet.repository.ts`,
`wallet/services/wallet.service.ts`, `sessions.service.ts` (`settle`).

---

## 3. Plan prices were charged at one tenth

**Problem.** Plan prices are `Decimal` dinars; wallets are integer millimes
(1 DT = 1000). Both purchase flows multiplied by 100, so a 15 DT plan cost 1.5 DT.

**Change.** New `common/utils/money.ts` with `dinarsToMillimes()` (×1000),
used by both `membership.service.ts` and `subscriptions.service.ts`.

---

## 4. Memberships and passes

### Expired memberships kept their discount

**Problem.** A membership's discount was looked up by `status: 'ACTIVE'`
only. Nothing flipped a membership to `EXPIRED` except the gamer buying a new
one, so the discount lasted forever.

**Change.** `MembershipService` expires lapsed memberships (end date before
today, UTC) before every lookup: `getActiveDiscountForGamer`, the new
`getBookingAdvanceDays`, and `GET /memberships/me`.

### Passes were paid for but did nothing

**Problem.** Buying a subscription pass debited the wallet and stored
`benefitsSnapshot`, but billing never read it. The same pass could also be
bought several times over.

**Change.**

- `SubscriptionsService.getWindowDiscountForGamer(gamerProfileId, at)` returns
  the best discount of the gamer's active passes at a given moment, read in
  `BUSINESS_TIMEZONE`. Only benefits in the API shape count; any other shape
  grants nothing:

  ```json
  { "windows": [{ "daysOfWeek": [0, 6], "startTime": "00:00", "endTime": "00:00", "discountPercent": 50 }] }
  ```

  Window rules (`subscriptions/util/benefit-window.ts`):
  - `daysOfWeek` runs from 0 = Sunday to 6 = Saturday.
  - The end time is exclusive, and `start == end` means the whole day.
  - A window that ends before it starts runs past midnight and belongs to the
    day it starts on (Fri 22:00–02:00 covers Sat 01:00).
- Buying a pass the gamer already holds (still active) is refused with
  `SUBSCRIPTION_ALREADY_ACTIVE`, before any charge. Different passes can
  still be combined. Lapsed passes are expired before the check and on
  `GET /subscriptions/me`.
- Seed plans converted to the `windows` shape:
  - **The Night Owl:** 100% off every day, 00:00–06:00.
  - **The Weekend Warrior:** 50% off all day Saturday and Sunday. It used to be
    "15 free hours on weekends", but the API has no hour allowances; change the
    discount if the business wants different terms.

`SessionBillingModule` now imports `SubscriptionsModule`.

---

## 5. How a session is priced

`SessionsService.computeRate()` now works as follows:

1. **Base rate:** `paygRate` for Play now (`reservation.isWalkIn`),
   `bookingRate` for a booking made ahead. Before, every session used `paygRate`.
2. **Discount:** the better of the membership discount and the pass window
   discount at the moment play starts. They don't stack.
   `appliedMembershipId` is set only when the membership's discount is the one
   used.
3. **Fixed for the session:** the rate is set when the PIN is issued. A Night
   Owl session that starts at 05:30 keeps its rate after 06:00. Billing by the
   minute across window boundaries would need metering history the session
   doesn't keep.

---

## 6. Bookings

**Problems.**
- A booking for tomorrow was refused unless the PC was switched on right now.
- A gamer could hold several PCs at the same time.
- The membership's `bookingAdvanceDays` was stored but never enforced.

**Change.**

- The PC must be `ONLINE` only for Play now. A booking for later just needs it
  `ENROLLED`; check-in checks it is online when the time comes.
- One gamer, one PC at a time: a booking overlapping another of the same
  gamer's bookings (PENDING, CONFIRMED or ACTIVE, on any PC) is refused with
  `GAMER_ALREADY_BOOKED`. A second advisory lock on the gamer keeps parallel
  requests honest; the locks are always taken machine first, then gamer, so
  they can't deadlock.
- A booking may start at most `max(bookingAdvanceDays, 1)` days ahead
  (`BOOKING_TOO_FAR_AHEAD`). Everyone can book the next 24 hours, including the
  Standard plan (0 days) and gamers without a membership.
- Walk-ins are stored with `isWalkIn: true`.

**Where.** `reservations/reservations.repository.ts`
(`createIfAvailable`), `reservations/reservations.service.ts`. `ReservationsModule`
now imports `MembershipModule`.

---

## 7. Balance and early check-in rules

- **Minimum balance:** a PIN (from check-in, walk-in or the staff fallback) is
  issued only when the balance covers `SESSION_MIN_PLAY_MINUTES` of play at the
  session's rate. Otherwise the answer is `INSUFFICIENT_FUNDS`. Free play (rate 0)
  is exempt. An existing unused PIN is kept when this check fails.
- **No PIN before its time:** a PIN is never issued more than 15 minutes
  before the booking, from the desk either. Before, the staff endpoint could
  issue today a PIN for tomorrow's booking, and it worked at once.

---

## 8. A top-up now resumes a session that ran out of funds

**Problem.** When the funds ran out, the runout timer locked the station and
the session went PAUSED. A top-up only rescheduled ACTIVE sessions, the PIN was
already used, and check-in refused because a session was open. Only staff
could get the gamer playing again.

**Change.**

- `lockForRunout()` sets `session.lockReason = 'runout'` before issuing the LOCK.
- On a wallet credit, if the gamer has no ACTIVE session but has a PAUSED one
  with `lockReason = 'runout'` still inside its window, and the balance covers
  the minimum play time again, the backend sends the station an UNLOCK
  (reason `topup`). The station reports itself unlocked, and the normal
  activation path sets the session ACTIVE, restarts metering and reschedules
  the runout timer.
- Activation clears `lockReason`. A session locked by staff has no
  `lockReason`, so a top-up never unlocks it.

**Where.** `sessions.service.ts` (`lockForRunout`, `onWalletCredited`,
`coversMinimumPlay`, `onStationStatus`), `sessions.repository.ts`
(`findPausedByGamer`).

---

## 9. Wallet permissions

**Problem.** Any employee could credit, debit or refund any wallet, with any
entry type (e.g. a credit marked `PAYMENT`).

**Change.**

| Call                                   | Who                                    |
|----------------------------------------|----------------------------------------|
| `POST /wallets/:id/credit`, type `CREDIT` (top-up) | staff and up                |
| `POST /wallets/:id/credit`, type `REFUND` / `ADJUSTMENT` | manager and up (`INSUFFICIENT_SCOPE` otherwise) |
| `POST /wallets/:id/debit`              | manager and up                         |

Entry types must match the direction of the money (a mismatch is a 400):
- **credit:** `CREDIT`, `REFUND`, `ADJUSTMENT`
- **debit:** `DEBIT`, `PAYMENT`, `ADJUSTMENT`

**Where.** `wallet/controllers/wallet.controller.ts`,
`wallet/schemas/wallet.schemas.ts`.

---

## 10. New error codes

| Code                          | Status | When                                                        |
|-------------------------------|--------|-------------------------------------------------------------|
| `RESERVATION_NOT_STARTED`     | 409    | PIN asked for more than 15 min before the booking           |
| `INSUFFICIENT_FUNDS`          | 409    | Balance below the minimum play time (also the existing wallet refusal) |
| `GAMER_ALREADY_BOOKED`        | 409    | The gamer already holds a booking overlapping this one      |
| `BOOKING_TOO_FAR_AHEAD`       | 400    | Booking starts beyond the plan's horizon                    |
| `SUBSCRIPTION_ALREADY_ACTIVE` | 409    | The gamer already holds this pass                           |
| `INSUFFICIENT_SCOPE`          | 403    | An employee tried a refund or an adjustment                 |

---

## 11. Tests

- **Unit** (`npx vitest run src`): all pass. New tests cover:
  - check-in and walk-in PINs
  - booking and walk-in rates, discounts that don't stack
  - minimum balance, early PIN refusal
  - shortfall settlement, runout resume
  - membership expiry and booking horizon
  - pass windows, duplicate passes
  - online-only-for-Play-now, one booking at a time
- **e2e** (`npm run test:e2e`, needs the migration applied). These were updated
  but **have not been run yet**:
  - `test/session-billing.e2e-spec.ts`:
    - gamers are created with a balance, test reservations are walk-ins
    - the gamer check-in flow
    - `INSUFFICIENT_FUNDS`, shortfall settlement
  - `test/plans.e2e-spec.ts`: prices in millimes, one pass at a time.
  - `test/wallet.e2e-spec.ts`: employee permissions, wrong-way entry types.
- **e2e, updated again on 2026-10-01** for the flow fixes; all 106 pass on a database with every
  migration (`FLOW_FIXES.md` §10):
  - every gamer sign-up sends its home `branchId`; `auth` checks a sign-up without one, or with an unknown
    one, is refused;
  - `session-billing`:
    - the PIN comes with the booking, is shown on it, and works only from its start (30 minutes);
    - the minimum balance is checked at login (`insufficient_funds`), not when the PIN is issued;
    - a booking or walk-in the wallet can't cover is refused (`INSUFFICIENT_FUNDS`), counting bookings
      already made;
    - no-show 30 minutes after the start frees the PC;
    - a system END_SESSION only reaches the station for the session it runs;
    - a staff UNLOCK resumes the station's own session, and after a runout lock needs the money;
  - `commands`: a staff UNLOCK with no session is refused (`NO_SESSION_TO_UNLOCK`);
  - `realtime`: a gamer's socket gets only its own events.

## 12. Known limits

- A pass discount is fixed when the PIN is issued, not split across window
  boundaries (§5).
- If staff lock a session that the runout timer had already locked, it keeps
  `lockReason = 'runout'`, so a top-up would unlock it.
- A booking for later needs no balance; only the PIN does. Bookings cost
  nothing up front, so no-shows cost the gamer nothing either.
