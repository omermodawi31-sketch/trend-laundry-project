/**
 * Pricing engine.
 *
 * Pure functions. No database, no clock, no config lookup — every input is an
 * argument. That makes the money maths unit-testable in isolation, which is
 * the single most valuable property this file can have.
 *
 * The client never computes totals. It sends variant ids and quantities; the
 * server prices them. Trusting a client-supplied `total` is how you get
 * one-dirham laundry orders.
 *
 * ROUNDING
 * --------
 * Every intermediate step rounds HALF_UP to 2 decimals before the next step
 * consumes it. Deferring rounding to the end produces totals that disagree
 * with the sum of the printed lines — the receipt says 10.00 + 10.00 but the
 * total says 20.01, and the cashier loses trust in the system.
 */

/** Round half-up to `dp` decimals. Avoids the float artefacts of toFixed. */
export function round(value: number, dp = 2): number {
  const factor = 10 ** dp;
  // Epsilon guards against 1.005 * 100 === 100.49999999999999.
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

export interface PriceableLine {
  /** Unit price captured from the variant at order time. */
  unitPrice: number;
  qty: number;
}

export interface PricedLine extends PriceableLine {
  lineTotal: number;
}

export interface PricingInput {
  lines: PriceableLine[];
  express: boolean;
  /** Percentage surcharge, e.g. 50 for +50%. From branch settings. */
  expressPct: number;
  delivery: boolean;
  /** Flat fee from branch settings. */
  deliveryFee: number;
  discountPct: number;
  vatEnabled: boolean;
  vatPct: number;
}

export interface PricingResult {
  lines: PricedLine[];
  pieces: number;
  subtotal: number;
  expressAmount: number;
  deliveryAmount: number;
  discountAmount: number;
  vatAmount: number;
  total: number;
}

/**
 * Order of operations, and why:
 *
 *   1. line_total   = qty × unit_price
 *   2. subtotal     = Σ line_total
 *   3. express      = subtotal × express_pct                 (service surcharge)
 *   4. discount     = (subtotal + express) × discount_pct    (applies to the
 *                     whole service value, including the rush premium — a
 *                     discount that excluded express would surprise customers)
 *   5. delivery     = flat fee, added AFTER discount so a percentage discount
 *                     never erodes the delivery cost, which is a pass-through
 *                     expense rather than margin
 *   6. taxable base = subtotal + express − discount + delivery
 *   7. VAT          = taxable base × vat_pct                 (UAE: VAT applies
 *                     to delivery too)
 *   8. total        = taxable base + VAT
 */
export function computePricing(input: PricingInput): PricingResult {
  const lines: PricedLine[] = input.lines.map((l) => ({
    ...l,
    lineTotal: round(l.qty * l.unitPrice),
  }));

  const pieces = lines.reduce((sum, l) => sum + l.qty, 0);
  const subtotal = round(lines.reduce((sum, l) => sum + l.lineTotal, 0));

  const expressAmount = input.express ? round(subtotal * (input.expressPct / 100)) : 0;

  const discountBase = round(subtotal + expressAmount);
  const discountAmount = input.discountPct > 0
    ? round(discountBase * (input.discountPct / 100))
    : 0;

  const deliveryAmount = input.delivery ? round(input.deliveryFee) : 0;

  const taxableBase = round(discountBase - discountAmount + deliveryAmount);

  const vatAmount = input.vatEnabled && input.vatPct > 0
    ? round(taxableBase * (input.vatPct / 100))
    : 0;

  const total = round(taxableBase + vatAmount);

  return {
    lines,
    pieces,
    subtotal,
    expressAmount,
    deliveryAmount,
    discountAmount,
    vatAmount,
    total,
  };
}

/**
 * Discount ceiling.
 *
 * Above this, the request is refused unless the caller holds a manager-level
 * permission. 50% is generous enough for legitimate goodwill and low enough
 * that a compromised cashier account cannot zero out revenue.
 */
export const MAX_DISCOUNT_PCT_WITHOUT_OVERRIDE = 50;

/** Outstanding balance on an order. Never negative. */
export function outstandingOf(total: number, paid: number): number {
  return round(Math.max(0, total - paid));
}
