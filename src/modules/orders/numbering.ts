/**
 * Order and invoice numbering.
 *
 * Two counters with deliberately different rules:
 *
 *   order_number    branch-scoped, resets daily      AJM1-260803-004
 *   invoice_number  business-scoped, gapless, yearly TL-INV-2026-000412
 *
 * WHY NOT POSTGRES SEQUENCES
 * --------------------------
 * Two reasons, either sufficient on its own:
 *
 *   1. Sequences are non-transactional. `nextval` is not rolled back. An
 *      order creation that fails after allocating a number leaves a gap. UAE
 *      FTA requires invoice numbers to be gapless per registrant, so a gap is
 *      a compliance problem, not an aesthetic one.
 *
 *   2. Order numbers are scoped per (business, branch, day). A sequence per
 *      scope means creating thousands of sequence objects and reaping them.
 *
 * A counter row plus `SELECT ... FOR UPDATE` gives transactional allocation:
 * roll back the order, roll back the number. Contention is per-branch-per-day
 * for orders and per-business-per-year for invoices — for a laundry, that is
 * a handful of concurrent writers at worst.
 *
 * The lock is held only for the duration of the enclosing transaction, which
 * in practice is a few milliseconds.
 */

import { sql, type Transaction } from "kysely";
import type { Database } from "../../lib/db.js";

/**
 * Local calendar date in the business timezone.
 *
 * A shop that closes at 1am does not want the next order counted against
 * tomorrow. Using UTC would roll the counter over mid-shift in UAE (UTC+4),
 * so the business timezone is what decides the date.
 */
export function localDateFor(timezone: string, at: Date = new Date()): string {
  // en-CA gives ISO-style YYYY-MM-DD from Intl, which avoids manual padding.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

/**
 * Allocate the next order number for a branch on a given local date.
 *
 * Format: {BRANCH_CODE}-{yymmdd}-{seq3}
 * Example: AJM1-260803-004
 *
 * The sequence is zero-padded to 3 digits but not capped — a branch taking
 * more than 999 orders in one day produces a 4-digit suffix rather than
 * wrapping, which would collide.
 */
export async function allocateOrderNumber(
  trx: Transaction<Database>,
  args: { businessId: number; branchId: number; branchCode: string; localDate: string },
): Promise<string> {
  // Upsert the counter row and increment atomically. ON CONFLICT DO UPDATE
  // takes a row lock for the duration of the transaction, so two concurrent
  // creations serialise here rather than producing duplicate numbers.
  const row = await sql<{ last_seq: number }>`
    INSERT INTO order_number_counters (business_id, branch_id, local_date, last_seq)
    VALUES (${args.businessId}, ${args.branchId}, ${args.localDate}::date, 1)
    ON CONFLICT (business_id, branch_id, local_date)
    DO UPDATE SET last_seq = order_number_counters.last_seq + 1
    RETURNING last_seq
  `.execute(trx);

  const seq = row.rows[0]!.last_seq;
  const [y, m, d] = args.localDate.split("-") as [string, string, string];
  const yymmdd = `${y.slice(2)}${m}${d}`;

  return `${args.branchCode}-${yymmdd}-${String(seq).padStart(3, "0")}`;
}

/**
 * Allocate the next invoice number for a business in a given year.
 *
 * Format: {PREFIX}-INV-{YYYY}-{seq6}
 * Example: TL-INV-2026-000412
 *
 * Called only when an order reaches `delivered`. Assigning at creation would
 * burn numbers on orders that are later cancelled, producing gaps that FTA
 * does not permit. The trade-off is that invoice order does not match
 * creation order — an order created Monday and delivered Friday gets a higher
 * number than one created Tuesday and delivered Wednesday. That is correct:
 * the invoice date is the delivery date.
 */
export async function allocateInvoiceNumber(
  trx: Transaction<Database>,
  args: { businessId: number; prefix: string; year: number },
): Promise<string> {
  const row = await sql<{ last_seq: number }>`
    INSERT INTO invoice_number_counters (business_id, year, last_seq)
    VALUES (${args.businessId}, ${args.year}, 1)
    ON CONFLICT (business_id, year)
    DO UPDATE SET last_seq = invoice_number_counters.last_seq + 1
    RETURNING last_seq
  `.execute(trx);

  const seq = row.rows[0]!.last_seq;
  return `${args.prefix}-INV-${args.year}-${String(seq).padStart(6, "0")}`;
}

/**
 * Derive an invoice prefix from the business name.
 *
 * Uses the English name's initials, falling back to "INV" when the name is
 * Arabic-only or unusable. A stable, human-recognisable prefix matters on a
 * printed invoice; the uniqueness guarantee comes from the counter, not the
 * prefix.
 */
export function invoicePrefixFor(businessNameEn: string | undefined): string {
  if (!businessNameEn) return "INV";
  const initials = businessNameEn
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0])
    .join("")
    .replace(/[^A-Za-z]/g, "")
    .toUpperCase()
    .slice(0, 4);
  return initials.length >= 2 ? initials : "INV";
}
