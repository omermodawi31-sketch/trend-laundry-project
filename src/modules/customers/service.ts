/**
 * Customers service.
 *
 * All business logic for the customers module. Route handlers are thin: they
 * validate input, call one of these functions, and serialise the result.
 *
 * Every function that mutates data:
 *   1. Runs inside `withTenant(...)` so RLS is active.
 *   2. Writes an audit row in the SAME transaction, so a change and its
 *      audit entry commit or roll back together.
 *
 * Every function that reads a single record returns `undefined` for both
 * "does not exist" and "belongs to another tenant". Handlers turn that into
 * a 404. This is deliberate: a 403 would confirm the row exists, which is an
 * ID-enumeration oracle (OWASP A01).
 */

import { withTenant } from "../../lib/db.js";
import { auditInTx, actorFromAuth } from "../../lib/audit.js";
import { Errors } from "../../lib/errors.js";
import type { AuthContext, Bilingual } from "../../shared/types.js";
import * as repo from "./repository.js";
import type {
  ActivityQueryInput,
  ChangeStatusInput,
  CreateCustomerInput,
  CreateNoteInput,
  ListQueryInput,
  UpdateCustomerInput,
} from "./schemas.js";

export interface RequestMeta {
  ipAddress: string | null;
  userAgent: string | null;
}

/* ---------------------------------------------------------------------- */
/*  Phone normalisation                                                    */
/* ---------------------------------------------------------------------- */

/**
 * Normalise a UAE phone number to E.164.
 *
 * Rules applied, in order:
 *   "050 347 4252"    -> "+971503474252"   (local mobile, leading 0 dropped)
 *   "00971503474252"  -> "+971503474252"   (international prefix)
 *   "+971503474252"   -> "+971503474252"   (already correct)
 *   "971503474252"    -> "+971503474252"   (country code without +)
 *
 * Storing a canonical form matters for duplicate detection: without it,
 * "050 347 4252" and "+971503474252" become two customers.
 *
 * A full libphonenumber integration is warranted once we serve more than one
 * country; for a UAE-only v1 this is deliberate, small, and testable.
 */
export function normalisePhone(raw: string, defaultCountry = "971"): string {
  const digits = raw.replace(/[^\d+]/g, "");

  if (digits.startsWith("+")) return digits;
  if (digits.startsWith("00")) return `+${digits.slice(2)}`;
  if (digits.startsWith(defaultCountry)) return `+${digits}`;
  if (digits.startsWith("0")) return `+${defaultCountry}${digits.slice(1)}`;
  return `+${defaultCountry}${digits}`;
}

/* ---------------------------------------------------------------------- */
/*  Cursor encoding                                                        */
/* ---------------------------------------------------------------------- */

/**
 * Opaque cursors.
 *
 * The cursor encodes (created_at, id). It is base64url so clients treat it as
 * a token rather than something to construct by hand — which keeps us free to
 * change the internal shape later.
 *
 * Decoding is defensive: a malformed or hostile cursor yields `undefined`
 * rather than throwing, and the query simply starts from the beginning.
 * A cursor is not a security boundary — RLS is — so a forged cursor can only
 * change *which page of the caller's own data* is returned.
 */
export function encodeCursor(createdAt: string, id: number): string {
  return Buffer.from(JSON.stringify({ c: createdAt, i: id }), "utf8").toString("base64url");
}

export function decodeCursor(cursor: string | undefined): { createdAt: string; id: number } | undefined {
  if (!cursor) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (
      typeof parsed !== "object" || parsed === null ||
      typeof (parsed as { c?: unknown }).c !== "string" ||
      typeof (parsed as { i?: unknown }).i !== "number"
    ) {
      return undefined;
    }
    const { c, i } = parsed as { c: string; i: number };
    if (!Number.isInteger(i) || i < 0) return undefined;
    if (Number.isNaN(Date.parse(c))) return undefined;
    return { createdAt: c, id: i };
  } catch {
    return undefined;
  }
}

/* ---------------------------------------------------------------------- */
/*  Serialisation                                                          */
/* ---------------------------------------------------------------------- */

/**
 * Public representation of a customer.
 *
 * Internal columns (`business_id`, `search_vector`, `created_by_user_id`)
 * are deliberately not emitted. Leaking `business_id` would tell a caller
 * their tenant's internal identifier for no benefit.
 */
export function serialiseCustomer(row: repo.CustomerRow, stats?: repo.CustomerStats) {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    whatsapp: row.whatsapp,
    email: row.email,
    address: row.address,
    maps_url: row.maps_url,
    photo_url: row.photo_url,
    emirates_id: row.emirates_id,
    tax_number: row.tax_number,
    preferred_branch_id: row.preferred_branch_id,
    status: row.status,
    status_reason: row.status_reason,
    status_changed_at: row.status_changed_at,
    vip: row.vip,
    tags: row.tags,
    favourite_services: row.favourite_services,
    pickup_preference: row.pickup_preference,
    preferred_locale: row.preferred_locale,
    marketing_opt_in: row.marketing_opt_in,
    since: row.since,
    created_at: row.created_at,
    updated_at: row.updated_at,
    deleted_at: row.deleted_at,
    ...(stats
      ? {
          stats: {
            orders_count: Number(stats.orders_count),
            completed_count: Number(stats.completed_count),
            cancelled_count: Number(stats.cancelled_count),
            pieces: Number(stats.pieces),
            lifetime_spend: Number(stats.lifetime_spend),
            lifetime_paid: Number(stats.lifetime_paid),
            outstanding: Number(stats.outstanding),
            loyalty_points: Number(stats.loyalty_points),
            last_visit_at: stats.last_visit_at,
            first_order_at: stats.first_order_at,
          },
        }
      : {}),
  };
}

/**
 * Fields we record in the audit `before`/`after` payloads.
 *
 * Not the whole row: audit rows stay small and diffs stay readable. We omit
 * timestamps (they are on the audit row itself) and any field that cannot
 * change.
 */
const AUDITED_FIELDS = [
  "name", "phone", "whatsapp", "email", "address", "maps_url", "photo_url",
  "emirates_id", "tax_number", "preferred_branch_id", "status", "status_reason",
  "vip", "tags", "favourite_services", "pickup_preference", "preferred_locale",
  "marketing_opt_in", "since",
] as const;

function auditSnapshot(row: repo.CustomerRow): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of AUDITED_FIELDS) out[f] = row[f];
  return out;
}

/** Only the fields that actually changed, so diffs are readable. */
function auditDiff(
  before: repo.CustomerRow,
  after: repo.CustomerRow,
): { before: Record<string, unknown>; after: Record<string, unknown> } {
  const b: Record<string, unknown> = {};
  const a: Record<string, unknown> = {};
  for (const f of AUDITED_FIELDS) {
    const bv = JSON.stringify(before[f]);
    const av = JSON.stringify(after[f]);
    if (bv !== av) {
      b[f] = before[f];
      a[f] = after[f];
    }
  }
  return { before: b, after: a };
}

/* ---------------------------------------------------------------------- */
/*  Commands                                                               */
/* ---------------------------------------------------------------------- */

export async function createCustomer(
  auth: AuthContext,
  input: CreateCustomerInput,
  meta: RequestMeta,
) {
  const phone = normalisePhone(input.phone);
  const whatsapp = input.whatsapp ? normalisePhone(input.whatsapp) : null;

  return withTenant({ businessId: auth.businessId, userId: auth.userId }, async (trx) => {
    // Duplicate check by canonical phone. The unique index is the real
    // guarantee; this check exists to return a helpful error instead of a
    // raw constraint violation.
    const existing = await repo.findByPhone(trx, phone);
    if (existing) {
      throw Errors.conflict(
        "customer-phone-exists",
        "A customer with this phone number already exists.",
        { customer_id: existing.id },
      );
    }

    const row = await repo.insert(trx, {
      business_id: auth.businessId,
      name: normaliseBilingual(input.name),
      phone,
      whatsapp,
      email: input.email ?? null,
      address: input.address ? normaliseBilingual(input.address) : null,
      maps_url: input.maps_url ?? null,
      emirates_id: input.emirates_id ?? null,
      tax_number: input.tax_number ?? null,
      photo_url: input.photo_url ?? null,
      preferred_branch_id: input.preferred_branch_id ?? null,
      status: input.status,
      status_reason: input.status_reason ?? null,
      vip: input.vip,
      tags: input.tags,
      favourite_services: input.favourite_services,
      pickup_preference: input.pickup_preference,
      preferred_locale: input.preferred_locale ?? null,
      marketing_opt_in: input.marketing_opt_in,
      since: input.since ?? new Date().toISOString().slice(0, 10),
      created_by_user_id: auth.userId,
    });

    if (input.note && input.note.trim().length > 0) {
      await repo.insertNote(trx, {
        business_id: auth.businessId,
        customer_id: row.id,
        body: input.note.trim(),
        pinned: true,
        created_by_user_id: auth.userId,
      });
    }

    await auditInTx(trx, actorFromAuth(auth, meta.ipAddress, meta.userAgent), {
      action: "customer.create",
      resourceType: "customer",
      resourceId: row.id,
      after: auditSnapshot(row),
    });

    return serialiseCustomer(row);
  });
}

export async function updateCustomer(
  auth: AuthContext,
  id: number,
  input: UpdateCustomerInput,
  meta: RequestMeta,
) {
  return withTenant({ businessId: auth.businessId, userId: auth.userId }, async (trx) => {
    const before = await repo.findById(trx, id);
    if (!before) throw Errors.notFound("Customer");

    const phone = input.phone !== undefined ? normalisePhone(input.phone) : undefined;

    // Changing the phone to one already used by another active customer would
    // violate the unique index; check first so the error is actionable.
    if (phone && phone !== before.phone) {
      const clash = await repo.findByPhone(trx, phone);
      if (clash && clash.id !== id) {
        throw Errors.conflict(
          "customer-phone-exists",
          "Another customer already uses this phone number.",
          { customer_id: clash.id },
        );
      }
    }

    const after = await repo.update(trx, id, {
      ...(input.name !== undefined ? { name: normaliseBilingual(input.name) } : {}),
      ...(phone !== undefined ? { phone } : {}),
      ...(input.whatsapp !== undefined
        ? { whatsapp: input.whatsapp ? normalisePhone(input.whatsapp) : null }
        : {}),
      ...(input.email !== undefined ? { email: input.email } : {}),
      ...(input.address !== undefined
        ? { address: input.address ? normaliseBilingual(input.address) : null }
        : {}),
      ...(input.maps_url !== undefined ? { maps_url: input.maps_url } : {}),
      ...(input.emirates_id !== undefined ? { emirates_id: input.emirates_id } : {}),
      ...(input.tax_number !== undefined ? { tax_number: input.tax_number } : {}),
      ...(input.photo_url !== undefined ? { photo_url: input.photo_url } : {}),
      ...(input.preferred_branch_id !== undefined ? { preferred_branch_id: input.preferred_branch_id } : {}),
      ...(input.vip !== undefined ? { vip: input.vip } : {}),
      ...(input.tags !== undefined ? { tags: input.tags } : {}),
      ...(input.favourite_services !== undefined ? { favourite_services: input.favourite_services } : {}),
      ...(input.pickup_preference !== undefined ? { pickup_preference: input.pickup_preference } : {}),
      ...(input.preferred_locale !== undefined ? { preferred_locale: input.preferred_locale } : {}),
      ...(input.marketing_opt_in !== undefined ? { marketing_opt_in: input.marketing_opt_in } : {}),
      ...(input.since !== undefined ? { since: input.since } : {}),
      updated_by_user_id: auth.userId,
    });

    if (!after) throw Errors.notFound("Customer");

    const diff = auditDiff(before, after);
    // Only write an audit row if something actually changed. A no-op PATCH
    // should not pollute the history.
    if (Object.keys(diff.after).length > 0) {
      await auditInTx(trx, actorFromAuth(auth, meta.ipAddress, meta.userAgent), {
        action: "customer.update",
        resourceType: "customer",
        resourceId: id,
        before: diff.before,
        after: diff.after,
      });
    }

    return serialiseCustomer(after);
  });
}

export async function changeStatus(
  auth: AuthContext,
  id: number,
  input: ChangeStatusInput,
  meta: RequestMeta,
) {
  return withTenant({ businessId: auth.businessId, userId: auth.userId }, async (trx) => {
    const before = await repo.findById(trx, id);
    if (!before) throw Errors.notFound("Customer");

    if (before.status === input.status) {
      // Idempotent: return current state without writing a spurious audit row.
      return serialiseCustomer(before);
    }

    const after = await repo.update(trx, id, {
      status: input.status,
      status_reason: input.reason ?? null,
      updated_by_user_id: auth.userId,
    });
    if (!after) throw Errors.notFound("Customer");

    await auditInTx(trx, actorFromAuth(auth, meta.ipAddress, meta.userAgent), {
      action: "customer.status_change",
      resourceType: "customer",
      resourceId: id,
      before: { status: before.status, status_reason: before.status_reason },
      after: { status: after.status, status_reason: after.status_reason },
    });

    return serialiseCustomer(after);
  });
}

export async function deleteCustomer(auth: AuthContext, id: number, meta: RequestMeta) {
  return withTenant({ businessId: auth.businessId, userId: auth.userId }, async (trx) => {
    const before = await repo.findById(trx, id);
    if (!before) throw Errors.notFound("Customer");

    // Refuse deletion when the customer has any order with money still
    // owed. This was deliberately absent through Phase 2 (orders did not
    // exist yet — a stub that always passed would have been worse than a
    // documented gap) and Phase 3 (customers predates orders in build
    // order). Orders exist now; the gap is closed here, minimally, without
    // a force-override — that is a separate feature decision, not part of
    // closing this gap.
    const unpaid = await repo.unpaidOrderSummary(trx, id);
    if (unpaid.count > 0) {
      throw Errors.conflict(
        "customer-has-unpaid-orders",
        "This customer has unpaid orders and cannot be deleted.",
        { unpaid_order_count: unpaid.count, unpaid_total: unpaid.totalOutstanding },
      );
    }

    const row = await repo.softDelete(trx, id, auth.userId);
    if (!row) throw Errors.notFound("Customer");

    await auditInTx(trx, actorFromAuth(auth, meta.ipAddress, meta.userAgent), {
      action: "customer.delete",
      resourceType: "customer",
      resourceId: id,
      before: auditSnapshot(before),
    });

    return { id, deleted_at: row.deleted_at };
  });
}

export async function restoreCustomer(auth: AuthContext, id: number, meta: RequestMeta) {
  return withTenant({ businessId: auth.businessId, userId: auth.userId }, async (trx) => {
    const before = await repo.findById(trx, id, { includeDeleted: true });
    if (!before) throw Errors.notFound("Customer");
    if (!before.deleted_at) {
      throw Errors.conflict("customer-not-deleted", "This customer is not deleted.");
    }

    // Restoring must not violate the unique phone index — another customer
    // may have taken the number while this one was deleted.
    const clash = await repo.findByPhone(trx, before.phone);
    if (clash && clash.id !== id) {
      throw Errors.conflict(
        "customer-phone-exists",
        "Another customer now uses this phone number. Change it before restoring.",
        { customer_id: clash.id },
      );
    }

    const row = await repo.restore(trx, id, auth.userId);
    if (!row) throw Errors.notFound("Customer");

    await auditInTx(trx, actorFromAuth(auth, meta.ipAddress, meta.userAgent), {
      action: "customer.restore",
      resourceType: "customer",
      resourceId: id,
      after: auditSnapshot(row),
    });

    return serialiseCustomer(row);
  });
}

/* ---------------------------------------------------------------------- */
/*  Queries                                                                */
/* ---------------------------------------------------------------------- */

export async function getCustomer(auth: AuthContext, id: number) {
  return withTenant({ businessId: auth.businessId, userId: auth.userId }, async (trx) => {
    const row = await repo.findById(trx, id, { includeDeleted: true });
    if (!row) throw Errors.notFound("Customer");
    const stats = await repo.statsFor(trx, id);
    return serialiseCustomer(row, stats);
  });
}

export async function listCustomers(auth: AuthContext, query: ListQueryInput) {
  return withTenant({ businessId: auth.businessId, userId: auth.userId }, async (trx) => {
    const filters: repo.ListFilters = {
      search: query.q,
      status: query.status,
      vip: query.vip,
      tags: query.tags,
      marketingOptIn: query.marketing_opt_in,
      includeDeleted: query.deleted === "include",
      onlyDeleted: query.deleted === "only",
    };

    // Fetch one extra row to determine whether another page exists without a
    // second COUNT query on the hot path.
    const rows = await repo.list(trx, auth.businessId, filters, {
      limit: query.limit + 1,
      cursor: decodeCursor(query.cursor),
      sort: query.sort,
      direction: query.direction,
    });

    const hasMore = rows.length > query.limit;
    const page = hasMore ? rows.slice(0, query.limit) : rows;
    const last = page[page.length - 1];

    return {
      data: page.map((r) => serialiseCustomer(r)),
      page_info: {
        has_more: hasMore,
        next_cursor: hasMore && last ? encodeCursor(last.created_at, last.id) : null,
        limit: query.limit,
      },
    };
  });
}

export async function getStatistics(auth: AuthContext) {
  return withTenant({ businessId: auth.businessId, userId: auth.userId }, async (trx) => {
    return repo.businessStatistics(trx, auth.businessId);
  });
}

export async function getActivity(auth: AuthContext, id: number, query: ActivityQueryInput) {
  return withTenant({ businessId: auth.businessId, userId: auth.userId }, async (trx) => {
    // Confirm the customer is visible to this tenant before returning history.
    // Without this, a caller could probe audit rows for arbitrary ids.
    const customer = await repo.findById(trx, id, { includeDeleted: true });
    if (!customer) throw Errors.notFound("Customer");

    const rows = await repo.activityFor(trx, id, query.limit + 1, query.before);
    const hasMore = rows.length > query.limit;
    const page = hasMore ? rows.slice(0, query.limit) : rows;
    const last = page[page.length - 1];

    return {
      data: page.map((r) => ({
        id: r.id,
        action: r.action,
        user_id: r.user_id,
        role: r.role_key,
        before: r.before,
        after: r.after,
        occurred_at: r.occurred_at,
      })),
      page_info: {
        has_more: hasMore,
        next_before: hasMore && last ? last.id : null,
      },
    };
  });
}

/* ---------------------------------------------------------------------- */
/*  Notes                                                                  */
/* ---------------------------------------------------------------------- */

export async function listNotes(auth: AuthContext, customerId: number) {
  return withTenant({ businessId: auth.businessId, userId: auth.userId }, async (trx) => {
    const customer = await repo.findById(trx, customerId, { includeDeleted: true });
    if (!customer) throw Errors.notFound("Customer");
    const notes = await repo.listNotes(trx, customerId);
    return notes.map((n) => ({
      id: n.id,
      body: n.body,
      pinned: n.pinned,
      created_by_user_id: n.created_by_user_id,
      created_at: n.created_at,
      updated_at: n.updated_at,
    }));
  });
}

export async function addNote(
  auth: AuthContext,
  customerId: number,
  input: CreateNoteInput,
  meta: RequestMeta,
) {
  return withTenant({ businessId: auth.businessId, userId: auth.userId }, async (trx) => {
    const customer = await repo.findById(trx, customerId);
    if (!customer) throw Errors.notFound("Customer");

    const note = await repo.insertNote(trx, {
      business_id: auth.businessId,
      customer_id: customerId,
      body: input.body,
      pinned: input.pinned,
      created_by_user_id: auth.userId,
    });

    await auditInTx(trx, actorFromAuth(auth, meta.ipAddress, meta.userAgent), {
      action: "customer.note_add",
      resourceType: "customer",
      resourceId: customerId,
      after: { note_id: note.id, pinned: note.pinned },
    });

    return {
      id: note.id,
      body: note.body,
      pinned: note.pinned,
      created_by_user_id: note.created_by_user_id,
      created_at: note.created_at,
      updated_at: note.updated_at,
    };
  });
}

export async function deleteNote(
  auth: AuthContext,
  customerId: number,
  noteId: number,
  meta: RequestMeta,
) {
  return withTenant({ businessId: auth.businessId, userId: auth.userId }, async (trx) => {
    const note = await repo.findNote(trx, noteId);
    // The note must exist AND belong to the customer in the path. Checking
    // only the note id would let a caller delete a note by guessing its id
    // while passing any customer id they can see.
    if (!note || note.customer_id !== customerId) throw Errors.notFound("Note");

    const ok = await repo.softDeleteNote(trx, noteId);
    if (!ok) throw Errors.notFound("Note");

    await auditInTx(trx, actorFromAuth(auth, meta.ipAddress, meta.userAgent), {
      action: "customer.note_delete",
      resourceType: "customer",
      resourceId: customerId,
      before: { note_id: noteId, body: note.body },
    });

    return { id: noteId, deleted: true };
  });
}

/* ---------------------------------------------------------------------- */
/*  Helpers                                                                */
/* ---------------------------------------------------------------------- */

/** Trim both sides and drop a language key that ends up empty. */
function normaliseBilingual(input: { en: string; ar: string }): Bilingual {
  return { en: (input.en ?? "").trim(), ar: (input.ar ?? "").trim() };
}
