/**
 * Orders service.
 *
 * Business logic for orders, payments and the services catalogue.
 *
 * INVARIANTS THIS FILE MAINTAINS
 * ------------------------------
 *  1. The client never supplies money. Totals are computed from the catalogue.
 *  2. Branch creation scope is narrower than branch read scope.
 *  3. Every mutation writes an audit row in the same transaction.
 *  4. `orders.paid_amount` is always recomputed from the payments ledger,
 *     never incremented, so a bug cannot make it drift permanently.
 *  5. Invoice numbers are allocated only on transition to `delivered`, so a
 *     cancelled order never burns one and the sequence stays gapless.
 *  6. Cross-branch and cross-tenant reads both surface as 404, never 403.
 */

import { withTenant } from "../../lib/db.js";
import type { Transaction } from "kysely";
import type { Database } from "../../lib/db.js";
import { auditInTx, actorFromAuth } from "../../lib/audit.js";
import { Errors } from "../../lib/errors.js";
import type { AuthContext, Bilingual } from "../../shared/types.js";
import * as repo from "./repository.js";
import {
  assertCanCreateForBranch,
  assertCanMutateOrder,
  canReadOrder,
  normaliseBranchTriple,
} from "./branch-scope.js";
import {
  computePricing,
  MAX_DISCOUNT_PCT_WITHOUT_OVERRIDE,
  outstandingOf,
  round,
} from "./pricing.js";
import {
  checkTransition,
  isEditable,
  type OrderStatus,
} from "./transitions.js";
import {
  allocateInvoiceNumber,
  allocateOrderNumber,
  invoicePrefixFor,
  localDateFor,
} from "./numbering.js";
import type {
  ChangeOrderStatusInput,
  CreateOrderInput,
  ListOrdersQueryInput,
  RecordPaymentInput,
  RefundInput,
  UpdateOrderLinesInput,
  UpdateOrderMetaInput,
} from "./schemas.js";

export interface RequestMeta {
  ipAddress: string | null;
  userAgent: string | null;
}

/* ---------------------------------------------------------------------- */
/*  Cursors                                                                */
/* ---------------------------------------------------------------------- */

export function encodeCursor(createdAt: string, id: number): string {
  return Buffer.from(JSON.stringify({ c: createdAt, i: id }), "utf8").toString("base64url");
}

export function decodeCursor(cursor?: string): { createdAt: string; id: number } | undefined {
  if (!cursor) return undefined;
  try {
    const p = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      c?: unknown; i?: unknown;
    };
    if (typeof p.c !== "string" || typeof p.i !== "number") return undefined;
    if (!Number.isInteger(p.i) || p.i < 0) return undefined;
    if (Number.isNaN(Date.parse(p.c))) return undefined;
    return { createdAt: p.c, id: p.i };
  } catch {
    return undefined;
  }
}

/* ---------------------------------------------------------------------- */
/*  Serialisation                                                          */
/* ---------------------------------------------------------------------- */

const n = (v: string | number | null | undefined): number => Number(v ?? 0);

export function serialiseOrder(
  row: repo.OrderRow,
  extras?: {
    lines?: repo.OrderLineRow[];
    payments?: repo.PaymentRow[];
    history?: repo.StatusHistoryRow[];
  },
) {
  const total = n(row.total);
  const paid = n(row.paid_amount);
  return {
    id: row.id,
    order_number: row.order_number,
    invoice_number: row.invoice_number,

    // The branch triple is exposed as resolved values so a client does not
    // have to know the NULL-means-same convention.
    branches: {
      intake_branch_id: row.intake_branch_id,
      processing_branch_id: row.processing_branch_id ?? row.intake_branch_id,
      collection_branch_id: row.collection_branch_id ?? row.intake_branch_id,
      // Raw values too, so an editor can tell "explicitly set" from "inherited".
      processing_explicit: row.processing_branch_id,
      collection_explicit: row.collection_branch_id,
    },

    customer: {
      id: row.customer_id,
      name: row.customer_name_snapshot,
      phone: row.customer_phone_snapshot,
    },

    status: row.status,
    pieces: row.pieces,

    totals: {
      subtotal: n(row.subtotal),
      express: row.express,
      express_pct: n(row.express_pct),
      express_amount: n(row.express_amount),
      delivery: row.delivery,
      delivery_amount: n(row.delivery_amount),
      discount_pct: n(row.discount_pct),
      discount_amount: n(row.discount_amount),
      discount_reason: row.discount_reason,
      vat_pct: n(row.vat_pct),
      vat_amount: n(row.vat_amount),
      total,
      paid_amount: paid,
      outstanding: outstandingOf(total, paid),
    },

    notes: row.notes,
    stain_notes: row.stain_notes,
    damage_notes: row.damage_notes,

    due_at: row.due_at,
    delivered_at: row.delivered_at,
    cancelled_at: row.cancelled_at,
    cancel_reason: row.cancel_reason,

    created_at: row.created_at,
    updated_at: row.updated_at,
    deleted_at: row.deleted_at,

    ...(extras?.lines
      ? {
          lines: extras.lines.map((l) => ({
            id: l.id,
            service_variant_id: l.service_variant_id,
            service_name: l.service_name_snapshot,
            service_type: l.service_type,
            size: l.size,
            qty: l.qty,
            unit_price: n(l.unit_price),
            line_total: n(l.line_total),
          })),
        }
      : {}),
    ...(extras?.payments
      ? {
          payments: extras.payments.map((p) => ({
            id: p.id,
            amount: n(p.amount),
            method: p.method,
            reference: p.reference,
            is_refund: p.refunded_from_payment_id !== null,
            refunded_from_payment_id: p.refunded_from_payment_id,
            refund_reason: p.refund_reason,
            received_at: p.received_at,
          })),
        }
      : {}),
    ...(extras?.history
      ? {
          history: extras.history.map((h) => ({
            from: h.from_status,
            to: h.to_status,
            branch_id: h.branch_id,
            user_id: h.changed_by_user_id,
            role: h.changed_by_role,
            note: h.note,
            at: h.changed_at,
          })),
        }
      : {}),
  };
}

/* ---------------------------------------------------------------------- */
/*  Create                                                                 */
/* ---------------------------------------------------------------------- */

export async function createOrder(
  auth: AuthContext,
  input: CreateOrderInput,
  meta: RequestMeta,
) {
  // Creation scope is narrower than read scope: you may only book revenue
  // against a branch you belong to.
  assertCanCreateForBranch(auth, input.intake_branch_id);

  return withTenant({ businessId: auth.businessId, userId: auth.userId }, async (trx) => {
    const branch = await repo.findBranch(trx, input.intake_branch_id);
    // RLS already scoped the lookup to this tenant, so a miss means the branch
    // does not exist *for this caller* — 404 rather than 403.
    if (!branch) throw Errors.notFound("Branch");

    for (const optional of [input.processing_branch_id, input.collection_branch_id]) {
      if (optional != null && !(await repo.findBranch(trx, optional))) {
        throw Errors.notFound("Branch");
      }
    }

    const business = await repo.findBusinessSettings(trx, auth.businessId);
    if (!business) throw Errors.internal("Business settings unavailable.");

    // Resolve the customer snapshot.
    let customerId: number | null = null;
    let nameSnapshot: Bilingual;
    let phoneSnapshot: string;

    if (input.customer_id != null) {
      const customer = await trx
        .selectFrom("customers")
        .select(["id", "name", "phone", "status"])
        .where("id", "=", input.customer_id)
        .where("deleted_at", "is", null)
        .executeTakeFirst();
      if (!customer) throw Errors.notFound("Customer");
      if (customer.status === "blocked") {
        throw Errors.conflict(
          "customer-blocked",
          "This customer is blocked and cannot place orders.",
        );
      }
      customerId = customer.id;
      nameSnapshot = customer.name as Bilingual;
      phoneSnapshot = customer.phone;
    } else {
      nameSnapshot = input.walk_in!.name;
      phoneSnapshot = input.walk_in!.phone;
    }

    // Price from the catalogue. The client's numbers are never trusted.
    const variantIds = [...new Set(input.lines.map((l) => l.service_variant_id))];
    const variants = await repo.findVariants(trx, variantIds);
    const byId = new Map(variants.map((v) => [v.id, v]));

    const missing = variantIds.filter((id) => !byId.has(id));
    if (missing.length > 0) {
      throw Errors.validation("One or more services are unavailable.", {
        unavailable_variant_ids: missing,
      });
    }

    // Discount ceiling. Above it, a manager-level permission is required.
    if (
      input.discount_pct > MAX_DISCOUNT_PCT_WITHOUT_OVERRIDE &&
      !auth.permissions.includes("orders.refund")
    ) {
      throw Errors.unauthorized(["orders.refund"]);
    }

    const priced = computePricing({
      lines: input.lines.map((l) => ({
        qty: l.qty,
        unitPrice: Number(byId.get(l.service_variant_id)!.unit_price),
      })),
      express: input.express,
      // Phase 6: rates come from Business Settings (business.vatPct /
      // business.expressPct / business.deliveryFee, read above via
      // findBusinessSettings), never a literal. Branch-level overrides
      // remain out of scope — every rate in this system, hardcoded or
      // configurable, has always been business-wide, and Phase 6 didn't
      // introduce a reason to change that.
      expressPct: input.express ? business.expressPct : 0,
      delivery: input.delivery,
      deliveryFee: input.delivery ? business.deliveryFee : 0,
      discountPct: input.discount_pct,
      vatEnabled: business.vatEnabled,
      vatPct: business.vatPct,
    });

    const triple = normaliseBranchTriple({
      intakeBranchId: input.intake_branch_id,
      processingBranchId: input.processing_branch_id,
      collectionBranchId: input.collection_branch_id,
    });

    const orderNumber = await allocateOrderNumber(trx, {
      businessId: auth.businessId,
      branchId: input.intake_branch_id,
      branchCode: branch.code,
      localDate: localDateFor(business.timezone),
    });

    const order = await repo.insertOrder(trx, {
      business_id: auth.businessId,
      ...triple,
      order_number: orderNumber,
      customer_id: customerId,
      customer_name_snapshot: nameSnapshot,
      customer_phone_snapshot: phoneSnapshot,
      pieces: priced.pieces,
      subtotal: priced.subtotal,
      express: input.express,
      express_pct: input.express ? business.expressPct : 0,
      express_amount: priced.expressAmount,
      delivery: input.delivery,
      delivery_amount: priced.deliveryAmount,
      discount_pct: input.discount_pct,
      discount_amount: priced.discountAmount,
      discount_reason: input.discount_reason ?? null,
      vat_pct: business.vatEnabled ? business.vatPct : 0,
      vat_amount: priced.vatAmount,
      total: priced.total,
      notes: input.notes ?? null,
      stain_notes: input.stain_notes ?? null,
      damage_notes: input.damage_notes ?? null,
      taken_by_user_id: auth.userId,
      due_at: input.due_at ?? null,
    });

    await repo.insertLines(
      trx,
      input.lines.map((l, i) => {
        const v = byId.get(l.service_variant_id)!;
        return {
          business_id: auth.businessId,
          order_id: order.id,
          service_variant_id: v.id,
          service_name_snapshot: v.service_name,
          service_type: v.service_type,
          size: v.size,
          qty: l.qty,
          unit_price: Number(v.unit_price),
          line_total: priced.lines[i]!.lineTotal,
        };
      }),
    );

    await repo.insertStatusHistory(trx, {
      business_id: auth.businessId,
      order_id: order.id,
      from_status: null,
      to_status: "received",
      branch_id: input.intake_branch_id,
      changed_by_user_id: auth.userId,
      changed_by_role: auth.roleKey,
      note: null,
    });

    let current = order;

    if (input.initial_payment) {
      if (input.initial_payment.amount > priced.total + 0.01) {
        throw Errors.validation("Payment exceeds the order total.", {
          total: priced.total,
          attempted: input.initial_payment.amount,
        });
      }
      await repo.insertPayment(trx, {
        business_id: auth.businessId,
        branch_id: input.intake_branch_id,
        order_id: order.id,
        customer_id: customerId,
        amount: input.initial_payment.amount,
        method: input.initial_payment.method,
        reference: input.initial_payment.reference ?? null,
        refunded_from_payment_id: null,
        refund_reason: null,
        received_by_user_id: auth.userId,
      });
      current = (await repo.recalcPaidAmount(trx, order.id))!;
    }

    await auditInTx(trx, actorFromAuth(auth, meta.ipAddress, meta.userAgent), {
      action: "order.create",
      resourceType: "order",
      resourceId: order.id,
      branchId: input.intake_branch_id,
      after: {
        order_number: orderNumber,
        total: priced.total,
        pieces: priced.pieces,
        intake_branch_id: triple.intake_branch_id,
        processing_branch_id: triple.processing_branch_id,
        collection_branch_id: triple.collection_branch_id,
      },
    });

    const lines = await repo.linesFor(trx, order.id);
    return serialiseOrder(current, { lines });
  });
}

/* ---------------------------------------------------------------------- */
/*  Read                                                                   */
/* ---------------------------------------------------------------------- */

export async function getOrder(auth: AuthContext, id: number) {
  return withTenant({ businessId: auth.businessId, userId: auth.userId }, async (trx) => {
    const order = await repo.findById(trx, id, { includeDeleted: true });
    // Not found and out-of-branch-scope both become 404. A 403 would confirm
    // the order exists, which is an enumeration oracle across branches.
    if (!order || !canReadOrder(auth, order)) throw Errors.notFound("Order");

    const [lines, payments, history] = await Promise.all([
      repo.linesFor(trx, id),
      repo.paymentsFor(trx, id),
      repo.historyFor(trx, id),
    ]);
    return serialiseOrder(order, { lines, payments, history });
  });
}

export async function listOrders(auth: AuthContext, query: ListOrdersQueryInput) {
  return withTenant({ businessId: auth.businessId, userId: auth.userId }, async (trx) => {
    const rows = await repo.list(
      trx,
      auth.businessId,
      { branchIds: auth.branchIds },
      {
        search: query.q,
        status: query.status,
        branchId: query.branch_id,
        customerId: query.customer_id,
        express: query.express,
        unpaidOnly: query.unpaid,
        from: query.from,
        to: query.to,
      },
      {
        limit: query.limit + 1,
        cursor: decodeCursor(query.cursor),
        direction: query.direction,
      },
    );

    const hasMore = rows.length > query.limit;
    const page = hasMore ? rows.slice(0, query.limit) : rows;
    const last = page[page.length - 1];

    return {
      data: page.map((r) => serialiseOrder(r)),
      page_info: {
        has_more: hasMore,
        next_cursor: hasMore && last ? encodeCursor(last.created_at, last.id) : null,
        limit: query.limit,
      },
    };
  });
}

/* ---------------------------------------------------------------------- */
/*  Mutate                                                                 */
/* ---------------------------------------------------------------------- */

export async function updateOrderLines(
  auth: AuthContext,
  id: number,
  input: UpdateOrderLinesInput,
  meta: RequestMeta,
) {
  return withTenant({ businessId: auth.businessId, userId: auth.userId }, async (trx) => {
    const order = await repo.findById(trx, id);
    if (!order || !canReadOrder(auth, order)) throw Errors.notFound("Order");
    assertCanMutateOrder(auth, order);

    if (!isEditable(order.status as OrderStatus)) {
      throw Errors.conflict(
        "order-not-editable",
        `An order in status '${order.status}' can no longer have its lines changed.`,
      );
    }

    const variantIds = [...new Set(input.lines.map((l) => l.service_variant_id))];
    const variants = await repo.findVariants(trx, variantIds);
    const byId = new Map(variants.map((v) => [v.id, v]));
    const missing = variantIds.filter((vid) => !byId.has(vid));
    if (missing.length > 0) {
      throw Errors.validation("One or more services are unavailable.", {
        unavailable_variant_ids: missing,
      });
    }

    const express = input.express ?? order.express;
    const delivery = input.delivery ?? order.delivery;
    const discountPct = input.discount_pct ?? Number(order.discount_pct);

    const business = await repo.findBusinessSettings(trx, auth.businessId);
    if (!business) throw Errors.internal("Business settings unavailable.");

    if (
      discountPct > MAX_DISCOUNT_PCT_WITHOUT_OVERRIDE &&
      !auth.permissions.includes("orders.refund")
    ) {
      throw Errors.unauthorized(["orders.refund"]);
    }

    const priced = computePricing({
      lines: input.lines.map((l) => ({
        qty: l.qty,
        unitPrice: Number(byId.get(l.service_variant_id)!.unit_price),
      })),
      express,
      expressPct: express ? business.expressPct : 0,
      delivery,
      deliveryFee: delivery ? business.deliveryFee : 0,
      discountPct,
      vatEnabled: business.vatEnabled,
      vatPct: business.vatPct,
    });

    // Repricing below what has already been paid would leave a negative
    // balance the refund flow has no record of. Refuse rather than silently
    // create one.
    if (priced.total + 0.01 < Number(order.paid_amount)) {
      throw Errors.conflict(
        "total-below-paid",
        "The new total is less than the amount already paid. Refund first.",
        { new_total: priced.total, already_paid: Number(order.paid_amount) },
      );
    }

    await repo.deleteLines(trx, id);
    await repo.insertLines(
      trx,
      input.lines.map((l, i) => {
        const v = byId.get(l.service_variant_id)!;
        return {
          business_id: auth.businessId,
          order_id: id,
          service_variant_id: v.id,
          service_name_snapshot: v.service_name,
          service_type: v.service_type,
          size: v.size,
          qty: l.qty,
          unit_price: Number(v.unit_price),
          line_total: priced.lines[i]!.lineTotal,
        };
      }),
    );

    const updated = await repo.updateTotals(trx, id, {
      pieces: priced.pieces,
      subtotal: priced.subtotal,
      express,
      express_pct: express ? business.expressPct : 0,
      express_amount: priced.expressAmount,
      delivery,
      delivery_amount: priced.deliveryAmount,
      discount_pct: discountPct,
      discount_amount: priced.discountAmount,
      discount_reason: input.discount_reason ?? order.discount_reason,
      vat_pct: business.vatEnabled ? business.vatPct : 0,
      vat_amount: priced.vatAmount,
      total: priced.total,
    });
    if (!updated) throw Errors.notFound("Order");

    await auditInTx(trx, actorFromAuth(auth, meta.ipAddress, meta.userAgent), {
      action: "order.lines_update",
      resourceType: "order",
      resourceId: id,
      branchId: order.intake_branch_id,
      before: { total: Number(order.total), pieces: order.pieces },
      after: { total: priced.total, pieces: priced.pieces },
    });

    const lines = await repo.linesFor(trx, id);
    return serialiseOrder(updated, { lines });
  });
}

export async function updateOrderMeta(
  auth: AuthContext,
  id: number,
  input: UpdateOrderMetaInput,
  meta: RequestMeta,
) {
  return withTenant({ businessId: auth.businessId, userId: auth.userId }, async (trx) => {
    const order = await repo.findById(trx, id);
    if (!order || !canReadOrder(auth, order)) throw Errors.notFound("Order");
    assertCanMutateOrder(auth, order);

    const updated = await repo.updateNotes(trx, id, {
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
      ...(input.stain_notes !== undefined ? { stain_notes: input.stain_notes } : {}),
      ...(input.damage_notes !== undefined ? { damage_notes: input.damage_notes } : {}),
      ...(input.due_at !== undefined ? { due_at: input.due_at } : {}),
    });
    if (!updated) throw Errors.notFound("Order");

    await auditInTx(trx, actorFromAuth(auth, meta.ipAddress, meta.userAgent), {
      action: "order.meta_update",
      resourceType: "order",
      resourceId: id,
      branchId: order.intake_branch_id,
      after: { fields: Object.keys(input) },
    });

    return serialiseOrder(updated);
  });
}

export async function changeStatus(
  auth: AuthContext,
  id: number,
  input: ChangeOrderStatusInput,
  meta: RequestMeta,
) {
  return withTenant({ businessId: auth.businessId, userId: auth.userId }, async (trx) => {
    const order = await repo.findById(trx, id);
    if (!order || !canReadOrder(auth, order)) throw Errors.notFound("Order");
    assertCanMutateOrder(auth, order);

    const from = order.status as OrderStatus;
    const to = input.to;
    const check = checkTransition(from, to);
    if (!check.allowed) {
      throw Errors.conflict("invalid-status-transition", check.reason ?? "Illegal transition.", {
        from,
        to,
      });
    }
    if (check.requiresReason && !(input.reason ?? "").trim()) {
      throw Errors.validation("A reason is required to cancel or write off an order.", {
        field: "reason",
      });
    }

    const patch: Parameters<typeof repo.updateStatus>[2] = { status: to };

    if (check.assignsInvoice && !order.invoice_number) {
      const business = await repo.findBusinessSettings(trx, auth.businessId);
      const prefix = invoicePrefixFor((business?.name as Bilingual | undefined)?.en);
      patch.invoice_number = await allocateInvoiceNumber(trx, {
        businessId: auth.businessId,
        prefix,
        year: new Date().getUTCFullYear(),
      });
    }
    if (to === "delivered") patch.delivered_at = new Date().toISOString();
    if (to === "cancelled" || to === "lost") {
      patch.cancelled_at = new Date().toISOString();
      patch.cancel_reason = input.reason ?? null;
    }

    const updated = await repo.updateStatus(trx, id, patch);
    if (!updated) throw Errors.notFound("Order");

    await repo.insertStatusHistory(trx, {
      business_id: auth.businessId,
      order_id: id,
      from_status: from,
      to_status: to,
      branch_id: order.processing_branch_id ?? order.intake_branch_id,
      changed_by_user_id: auth.userId,
      changed_by_role: auth.roleKey,
      note: input.note ?? input.reason ?? null,
    });

    await auditInTx(trx, actorFromAuth(auth, meta.ipAddress, meta.userAgent), {
      action: "order.status_change",
      resourceType: "order",
      resourceId: id,
      branchId: order.intake_branch_id,
      before: { status: from },
      after: {
        status: to,
        ...(patch.invoice_number ? { invoice_number: patch.invoice_number } : {}),
      },
    });

    // Phase 4 hooks inventory consumption on `check.triggersConsumption`.
    // Deliberately not stubbed — an empty branch that looks wired is worse
    // than an obvious gap.

    return serialiseOrder(updated);
  });
}

/**
 * The actual payment-recording logic, extracted so it can run inside an
 * ALREADY-OPEN transaction — needed by Phase 7's delivery module, which
 * must record a cash-on-delivery payment in the same atomic transaction as
 * completing a delivery job, not as a second, independent transaction.
 *
 * `recordPayment` below is the unchanged public entry point every existing
 * caller (this module's own routes) still uses — it just opens its own
 * transaction and delegates here. Zero behavior change for any existing
 * caller; this split exists solely to make cross-module reuse safe.
 */
export async function recordPaymentInTx(
  trx: Transaction<Database>,
  auth: AuthContext,
  id: number,
  input: RecordPaymentInput,
  meta: RequestMeta,
) {
  const order = await repo.findById(trx, id);
  if (!order || !canReadOrder(auth, order)) throw Errors.notFound("Order");
  assertCanMutateOrder(auth, order);

  if (order.status === "cancelled" || order.status === "lost") {
    throw Errors.conflict("order-not-payable", "A cancelled order cannot take payment.");
  }

  const outstanding = outstandingOf(Number(order.total), Number(order.paid_amount));
  if (input.amount > outstanding + 0.01) {
    throw Errors.validation("Payment exceeds the outstanding balance.", {
      outstanding,
      attempted: input.amount,
    });
  }

  const payment = await repo.insertPayment(trx, {
    business_id: auth.businessId,
    branch_id: order.collection_branch_id ?? order.intake_branch_id,
    order_id: id,
    customer_id: order.customer_id,
    amount: input.amount,
    method: input.method,
    reference: input.reference ?? null,
    refunded_from_payment_id: null,
    refund_reason: null,
    received_by_user_id: auth.userId,
  });

  const updated = (await repo.recalcPaidAmount(trx, id))!;

  await auditInTx(trx, actorFromAuth(auth, meta.ipAddress, meta.userAgent), {
    action: "order.payment_record",
    resourceType: "order",
    resourceId: id,
    branchId: order.intake_branch_id,
    after: { payment_id: payment.id, amount: input.amount, method: input.method },
  });

  const payments = await repo.paymentsFor(trx, id);
  return serialiseOrder(updated, { payments });
}

export async function recordPayment(
  auth: AuthContext,
  id: number,
  input: RecordPaymentInput,
  meta: RequestMeta,
) {
  return withTenant({ businessId: auth.businessId, userId: auth.userId }, (trx) =>
    recordPaymentInTx(trx, auth, id, input, meta),
  );
}

export async function refundPayment(
  auth: AuthContext,
  id: number,
  input: RefundInput,
  meta: RequestMeta,
) {
  return withTenant({ businessId: auth.businessId, userId: auth.userId }, async (trx) => {
    const order = await repo.findById(trx, id);
    if (!order || !canReadOrder(auth, order)) throw Errors.notFound("Order");
    assertCanMutateOrder(auth, order);

    const original = await repo.findPayment(trx, input.payment_id);
    // The payment must belong to this order. Checking only the payment id
    // would let a caller refund against any order they can see.
    if (!original || original.order_id !== id) throw Errors.notFound("Payment");
    if (original.refunded_from_payment_id !== null) {
      throw Errors.conflict("cannot-refund-a-refund", "That record is itself a refund.");
    }

    const already = await repo.refundedTotalFor(trx, original.id);
    const refundable = round(Number(original.amount) - already);
    if (input.amount > refundable + 0.01) {
      throw Errors.validation("Refund exceeds the refundable amount for that payment.", {
        original_amount: Number(original.amount),
        already_refunded: already,
        refundable,
      });
    }

    // A refund is a new negative row, never an edit. The payments table is
    // append-only in the database, so an edit would be refused anyway.
    const refund = await repo.insertPayment(trx, {
      business_id: auth.businessId,
      branch_id: original.branch_id,
      order_id: id,
      customer_id: order.customer_id,
      amount: -input.amount,
      method: original.method,
      reference: original.reference,
      refunded_from_payment_id: original.id,
      refund_reason: input.reason,
      received_by_user_id: auth.userId,
    });

    const updated = (await repo.recalcPaidAmount(trx, id))!;

    await auditInTx(trx, actorFromAuth(auth, meta.ipAddress, meta.userAgent), {
      action: "order.refund",
      resourceType: "order",
      resourceId: id,
      branchId: order.intake_branch_id,
      after: {
        refund_payment_id: refund.id,
        original_payment_id: original.id,
        amount: input.amount,
        reason: input.reason,
      },
    });

    const payments = await repo.paymentsFor(trx, id);
    return serialiseOrder(updated, { payments });
  });
}

export async function deleteOrder(auth: AuthContext, id: number, meta: RequestMeta) {
  return withTenant({ businessId: auth.businessId, userId: auth.userId }, async (trx) => {
    const order = await repo.findById(trx, id);
    if (!order || !canReadOrder(auth, order)) throw Errors.notFound("Order");
    assertCanMutateOrder(auth, order);

    if (Number(order.paid_amount) > 0) {
      throw Errors.conflict(
        "order-has-payments",
        "An order with recorded payments cannot be deleted. Cancel it instead.",
        { paid_amount: Number(order.paid_amount) },
      );
    }

    const ok = await repo.softDeleteOrder(trx, id);
    if (!ok) throw Errors.notFound("Order");

    await auditInTx(trx, actorFromAuth(auth, meta.ipAddress, meta.userAgent), {
      action: "order.delete",
      resourceType: "order",
      resourceId: id,
      branchId: order.intake_branch_id,
      before: { order_number: order.order_number, total: Number(order.total) },
    });

    return { id, deleted: true };
  });
}

/* ---------------------------------------------------------------------- */
/*  Services catalogue                                                     */
/* ---------------------------------------------------------------------- */

export async function listServices(auth: AuthContext) {
  return withTenant({ businessId: auth.businessId, userId: auth.userId }, async (trx) => {
    const services = await trx
      .selectFrom("services")
      .select(["id", "name", "category", "service_type", "is_active", "sort_order"])
      .where("business_id", "=", auth.businessId)
      .where("deleted_at", "is", null)
      .orderBy("sort_order", "asc")
      .orderBy("id", "asc")
      .execute();

    const variants = await trx
      .selectFrom("service_variants")
      .select(["id", "service_id", "size", "unit_price", "express_multiplier", "is_active"])
      .where("business_id", "=", auth.businessId)
      .where("deleted_at", "is", null)
      .orderBy("id", "asc")
      .execute();

    const byService = new Map<number, typeof variants>();
    for (const v of variants) {
      const arr = byService.get(v.service_id) ?? [];
      arr.push(v);
      byService.set(v.service_id, arr);
    }

    return services.map((s) => ({
      id: s.id,
      name: s.name,
      category: s.category,
      service_type: s.service_type,
      is_active: s.is_active,
      sort_order: s.sort_order,
      variants: (byService.get(s.id) ?? []).map((v) => ({
        id: v.id,
        size: v.size,
        unit_price: Number(v.unit_price),
        express_multiplier: Number(v.express_multiplier),
        is_active: v.is_active,
      })),
    }));
  });
}

export async function createService(
  auth: AuthContext,
  input: {
    name: Bilingual;
    category: string;
    service_type: "wash" | "press" | "washpress" | "drycl";
    sort_order: number;
    variants: Array<{ size?: string | null; unit_price: number; express_multiplier: number }>;
  },
  meta: RequestMeta,
) {
  return withTenant({ businessId: auth.businessId, userId: auth.userId }, async (trx) => {
    const service = await trx
      .insertInto("services")
      .values({
        business_id: auth.businessId,
        name: input.name as never,
        category: input.category,
        service_type: input.service_type,
        sort_order: input.sort_order,
      })
      .returning(["id", "name", "category", "service_type", "is_active", "sort_order"])
      .executeTakeFirstOrThrow();

    await trx
      .insertInto("service_variants")
      .values(
        input.variants.map((v) => ({
          business_id: auth.businessId,
          service_id: service.id,
          size: v.size ?? null,
          unit_price: v.unit_price,
          express_multiplier: v.express_multiplier,
        })),
      )
      .execute();

    await auditInTx(trx, actorFromAuth(auth, meta.ipAddress, meta.userAgent), {
      action: "service.create",
      resourceType: "service",
      resourceId: service.id,
      after: { name: input.name, variants: input.variants.length },
    });

    return service;
  });
}
