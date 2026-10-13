export interface PricingRecord {
  paygRate: number;
  bookingRate: number;
  updatedAt: Date;
}

export function toPublicPricing(pricing: PricingRecord) {
  return {
    paygRate: pricing.paygRate,
    bookingRate: pricing.bookingRate,
    updatedAt: pricing.updatedAt,
  };
}
