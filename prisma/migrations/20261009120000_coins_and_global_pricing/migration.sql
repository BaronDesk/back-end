-- Coins: every money column holds whole coins (1000 coins = 1 DT). Wallets,
-- the ledger and the hourly rates were millimes, the same numbers, so they
-- stay as they are.

-- One price list for every branch: a single row (id 1), carrying over the
-- most recently changed branch prices.
CREATE TABLE "pricing_global" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "payg_rate" INTEGER NOT NULL,
    "booking_rate" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "pricing_global_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "pricing_single_row" CHECK ("id" = 1)
);

INSERT INTO "pricing_global" ("id", "payg_rate", "booking_rate", "created_at", "updated_at")
SELECT 1, "payg_rate", "booking_rate", "created_at", "updated_at"
FROM "pricing"
ORDER BY "updated_at" DESC
LIMIT 1;

DROP TABLE "pricing";
ALTER TABLE "pricing_global" RENAME TO "pricing";
ALTER TABLE "pricing" RENAME CONSTRAINT "pricing_global_pkey" TO "pricing_pkey";

-- Plan prices: dinars (Decimal) -> coins.
ALTER TABLE "membership_plans" ALTER COLUMN "price" TYPE INTEGER USING ROUND("price" * 1000)::INTEGER;
ALTER TABLE "subscription_plans" ALTER COLUMN "price" TYPE INTEGER USING ROUND("price" * 1000)::INTEGER;

-- Session rates: millimes per minute -> coins per hour (billed by the second).
ALTER TABLE "sessions" RENAME COLUMN "rate_cents_per_minute" TO "rate_coins_per_hour";
ALTER TABLE "sessions" RENAME COLUMN "next_rate_cents_per_minute" TO "next_rate_coins_per_hour";
ALTER TABLE "sessions" RENAME COLUMN "accrued_cents" TO "accrued_coins";
UPDATE "sessions" SET "rate_coins_per_hour" = "rate_coins_per_hour" * 60 WHERE "rate_coins_per_hour" IS NOT NULL;
UPDATE "sessions" SET "next_rate_coins_per_hour" = "next_rate_coins_per_hour" * 60 WHERE "next_rate_coins_per_hour" IS NOT NULL;

-- Settled bills: the same keys renamed (the per-minute rate becomes per hour).
UPDATE "sessions"
SET "billing_breakdown" =
    ("billing_breakdown" - 'rateCentsPerMinute' - 'accruedCents' - 'totalCents' - 'chargedCents' - 'shortfallCents')
    || jsonb_strip_nulls(jsonb_build_object(
        'rateCoinsPerHour', ("billing_breakdown" ->> 'rateCentsPerMinute')::NUMERIC * 60,
        'accruedCoins', "billing_breakdown" -> 'accruedCents',
        'totalCoins', "billing_breakdown" -> 'totalCents',
        'chargedCoins', "billing_breakdown" -> 'chargedCents',
        'shortfallCoins', "billing_breakdown" -> 'shortfallCents'
    ))
WHERE jsonb_typeof("billing_breakdown") = 'object';
