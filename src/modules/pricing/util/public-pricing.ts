export interface PricingRecord {
  id: string;
  branchId: string;
  paygRate: number;
  bookingRate: number;
  updatedAt: Date;
}

export function toPublicPricing(pricing: PricingRecord) {
  return {
    id: pricing.id,
    branchId: pricing.branchId,
    paygRate: pricing.paygRate,
    bookingRate: pricing.bookingRate,
    updatedAt: pricing.updatedAt,
  };
}
