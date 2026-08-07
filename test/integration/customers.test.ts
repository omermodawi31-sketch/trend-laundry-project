/**
 * Customers module — functional behaviour.
 *
 * Complements the security suites. Covers the business rules the module
 * promises: bilingual search, pagination, soft delete/restore, status
 * lifecycle, notes, and — importantly — that every mutation writes an
 * audit row (OWASP A09).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/api.js";
import { login, signupOwnerAndBusiness } from "../../src/modules/auth/service.js";
import { normalisePhone, decodeCursor, encodeCursor } from "../../src/modules/customers/service.js";
import { ensureMigrated, teardown, truncateAll } from "../helpers/harness.js";

const PW = "correct-horse-battery-staple";
let app: FastifyInstance;
let token: string;

async function setup(): Promise<void> {
  await signupOwnerAndBusiness(
    {
      business: { name: { en: "Func Laundry", ar: "مصبغة" } },
      owner: { email: "func@example.com", full_name: "Owner", password: PW },
      branch: { name: { en: "Main", ar: "الرئيسية" }, code: "F1", address: { en: "x", ar: "س" } },
    },
    { ipAddress: null, userAgent: null },
  );
  const s = await login({ email: "func@example.com", password: PW }, { ipAddress: null, userAgent: null });
  token = s.access_token;
}

function auth() {
  return { authorization: `Bearer ${token}` };
}

async function createCustomer(payload: Record<string, unknown>) {
  const res = await app.inject({ method: "POST", url: "/customers", headers: auth(), payload });
  expect(res.statusCode).toBe(201);
  return res.json().customer;
}

/* ---------------------------------------------------------------- */

describe("phone normalisation (pure function)", () => {
  it.each([
    ["050 347 4252", "+971503474252"],
    ["0503474252", "+971503474252"],
    ["00971503474252", "+971503474252"],
    ["+971503474252", "+971503474252"],
    ["971503474252", "+971503474252"],
    ["05 03 47 42 52", "+971503474252"],
    ["(050) 347-4252", "+971503474252"],
  ])("normalises %s to %s", (input, expected) => {
    expect(normalisePhone(input)).toBe(expected);
  });
});

describe("cursor codec (pure function)", () => {
  it("round-trips", () => {
    const c = encodeCursor("2026-08-04T10:00:00.000Z", 42);
    expect(decodeCursor(c)).toEqual({ createdAt: "2026-08-04T10:00:00.000Z", id: 42 });
  });

  it.each(["", "not-base64!!", "e30", "bnVsbA", "W10"])("returns undefined for malformed cursor %s", (bad) => {
    expect(decodeCursor(bad)).toBeUndefined();
  });
});

/* ---------------------------------------------------------------- */

describe("customers CRUD", () => {
  beforeAll(async () => { await ensureMigrated(); app = await buildApp(); });
  beforeEach(async () => { await truncateAll(); await setup(); });
  afterAll(async () => { await app.close(); await teardown(); });

  it("creates a customer and normalises the phone", async () => {
    const c = await createCustomer({
      name: { en: "Ahmed Al Marzooqi", ar: "أحمد المرزوقي" },
      phone: "050 347 4252",
    });
    expect(c.phone).toBe("+971503474252");
    expect(c.status).toBe("active");
    expect(c.vip).toBe(false);
    // Internal fields must not leak.
    expect(c.business_id).toBeUndefined();
    expect(c.search_vector).toBeUndefined();
  });

  it("rejects a duplicate phone with a structured conflict", async () => {
    await createCustomer({ name: { en: "First", ar: "" }, phone: "0501112222" });
    const res = await app.inject({
      method: "POST", url: "/customers", headers: auth(),
      payload: { name: { en: "Second", ar: "" }, phone: "050 111 2222" },  // same after normalisation
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("customer-phone-exists");
    expect(res.json().details.customer_id).toBeTruthy();
  });

  it("updates only the supplied fields", async () => {
    const c = await createCustomer({ name: { en: "Original", ar: "أصلي" }, phone: "0501112222" });
    const res = await app.inject({
      method: "PATCH", url: `/customers/${c.id}`, headers: auth(),
      payload: { vip: true, tags: ["corporate"] },
    });
    expect(res.statusCode).toBe(200);
    const updated = res.json().customer;
    expect(updated.vip).toBe(true);
    expect(updated.tags).toEqual(["corporate"]);
    expect(updated.name).toEqual({ en: "Original", ar: "أصلي" });   // untouched
  });

  it("creates a pinned note when `note` is supplied at creation", async () => {
    const c = await createCustomer({
      name: { en: "With Note", ar: "" },
      phone: "0503334444",
      note: "Prefers no starch",
    });
    const res = await app.inject({ method: "GET", url: `/customers/${c.id}/notes`, headers: auth() });
    expect(res.statusCode).toBe(200);
    expect(res.json().notes).toHaveLength(1);
    expect(res.json().notes[0].pinned).toBe(true);
  });

  it("returns zeroed stats until Phase 3 wires orders", async () => {
    const c = await createCustomer({ name: { en: "Stats", ar: "" }, phone: "0505556666" });
    const res = await app.inject({ method: "GET", url: `/customers/${c.id}`, headers: auth() });
    const stats = res.json().customer.stats;
    expect(stats.orders_count).toBe(0);
    expect(stats.outstanding).toBe(0);
    expect(stats.last_visit_at).toBeNull();
  });
});

/* ---------------------------------------------------------------- */

describe("bilingual search", () => {
  beforeAll(async () => { await ensureMigrated(); app = await buildApp(); });
  beforeEach(async () => {
    await truncateAll(); await setup();
    await createCustomer({ name: { en: "Ahmed Al Marzooqi", ar: "أحمد المرزوقي" }, phone: "0501111111" });
    await createCustomer({ name: { en: "Priya Nair", ar: "بريا ناير" }, phone: "0502222222" });
    await createCustomer({
      name: { en: "Gulf Crest Hotel", ar: "فندق جلف كرست" },
      phone: "0503333333",
      address: { en: "Sheikh Humaid St, Ajman", ar: "شارع الشيخ حميد، عجمان" },
      tags: ["corporate"],
    });
  });
  afterAll(async () => { await app.close(); await teardown(); });

  async function search(q: string) {
    const res = await app.inject({
      method: "GET", url: `/customers?q=${encodeURIComponent(q)}`, headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    return res.json().data as Array<{ name: { en: string; ar: string } }>;
  }

  it("finds by English name", async () => {
    const r = await search("Ahmed");
    expect(r).toHaveLength(1);
    expect(r[0]!.name.en).toBe("Ahmed Al Marzooqi");
  });

  it("finds by Arabic name", async () => {
    const r = await search("أحمد");
    expect(r).toHaveLength(1);
    expect(r[0]!.name.ar).toBe("أحمد المرزوقي");
  });

  it("finds Arabic name typed without hamza — the normalisation payoff", async () => {
    // "احمد" (plain alef) must match "أحمد" (alef with hamza).
    const r = await search("احمد");
    expect(r).toHaveLength(1);
    expect(r[0]!.name.ar).toBe("أحمد المرزوقي");
  });

  it("finds by phone", async () => {
    const r = await search("0502222222");
    expect(r.length).toBeGreaterThanOrEqual(1);
  });

  it("finds by address in either language", async () => {
    expect((await search("Ajman")).length).toBeGreaterThanOrEqual(1);
    expect((await search("عجمان")).length).toBeGreaterThanOrEqual(1);
  });

  it("finds by tag", async () => {
    const r = await search("corporate");
    expect(r.length).toBeGreaterThanOrEqual(1);
  });

  it("returns an empty list for a term that matches nothing", async () => {
    expect(await search("zzzzznothing")).toHaveLength(0);
  });
});

/* ---------------------------------------------------------------- */

describe("filtering, sorting and pagination", () => {
  beforeAll(async () => { await ensureMigrated(); app = await buildApp(); });
  beforeEach(async () => {
    await truncateAll(); await setup();
    for (let i = 1; i <= 12; i++) {
      await createCustomer({
        name: { en: `Customer ${String(i).padStart(2, "0")}`, ar: `عميل ${i}` },
        phone: `05011111${String(i).padStart(2, "0")}`,
        vip: i % 3 === 0,
        tags: i % 2 === 0 ? ["corporate"] : [],
      });
    }
  });
  afterAll(async () => { await app.close(); await teardown(); });

  it("paginates with a stable cursor and no duplicates", async () => {
    const seen = new Set<number>();
    let cursor: string | null = null;
    let pages = 0;

    do {
      const url: string = cursor ? `/customers?limit=5&cursor=${encodeURIComponent(cursor)}` : "/customers?limit=5";
      const res = await app.inject({ method: "GET", url, headers: auth() });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      for (const c of body.data) {
        expect(seen.has(c.id)).toBe(false);   // no duplicates across pages
        seen.add(c.id);
      }
      cursor = body.page_info.next_cursor;
      pages++;
      expect(pages).toBeLessThan(10);          // guard against infinite loop
    } while (cursor);

    expect(seen.size).toBe(12);
  });

  it("filters by vip", async () => {
    const res = await app.inject({ method: "GET", url: "/customers?vip=true&limit=100", headers: auth() });
    const data = res.json().data as Array<{ vip: boolean }>;
    expect(data.length).toBe(4);              // i = 3,6,9,12
    expect(data.every((c) => c.vip)).toBe(true);
  });

  it("filters by tag", async () => {
    const res = await app.inject({ method: "GET", url: "/customers?tags=corporate&limit=100", headers: auth() });
    expect(res.json().data.length).toBe(6);   // even i
  });

  it("sorts by name ascending", async () => {
    const res = await app.inject({
      method: "GET", url: "/customers?sort=name&direction=asc&limit=100", headers: auth(),
    });
    const names = (res.json().data as Array<{ name: { en: string } }>).map((c) => c.name.en);
    expect(names).toEqual([...names].sort());
  });
});

/* ---------------------------------------------------------------- */

describe("status lifecycle, soft delete and restore", () => {
  beforeAll(async () => { await ensureMigrated(); app = await buildApp(); });
  beforeEach(async () => { await truncateAll(); await setup(); });
  afterAll(async () => { await app.close(); await teardown(); });

  it("changes status and records the reason", async () => {
    const c = await createCustomer({ name: { en: "Status", ar: "" }, phone: "0501112222" });
    const res = await app.inject({
      method: "POST", url: `/customers/${c.id}/status`, headers: auth(),
      payload: { status: "blocked", reason: "Cheque bounced twice" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().customer.status).toBe("blocked");
    expect(res.json().customer.status_reason).toBe("Cheque bounced twice");
    expect(res.json().customer.status_changed_at).toBeTruthy();
  });

  it("soft delete hides the customer from the default list but keeps the row", async () => {
    const c = await createCustomer({ name: { en: "Doomed", ar: "" }, phone: "0501112222" });

    const del = await app.inject({ method: "DELETE", url: `/customers/${c.id}`, headers: auth() });
    expect(del.statusCode).toBe(200);
    expect(del.json().deleted_at).toBeTruthy();

    const list = await app.inject({ method: "GET", url: "/customers", headers: auth() });
    expect(list.json().data).toHaveLength(0);

    const deletedOnly = await app.inject({ method: "GET", url: "/customers?deleted=only", headers: auth() });
    expect(deletedOnly.json().data).toHaveLength(1);

    // Direct GET still works so the record can be inspected and restored.
    const got = await app.inject({ method: "GET", url: `/customers/${c.id}`, headers: auth() });
    expect(got.statusCode).toBe(200);
    expect(got.json().customer.deleted_at).toBeTruthy();
  });

  it("restores a soft-deleted customer", async () => {
    const c = await createCustomer({ name: { en: "Returning", ar: "" }, phone: "0501112222" });
    await app.inject({ method: "DELETE", url: `/customers/${c.id}`, headers: auth() });

    const res = await app.inject({ method: "POST", url: `/customers/${c.id}/restore`, headers: auth() });
    expect(res.statusCode).toBe(200);
    expect(res.json().customer.deleted_at).toBeNull();

    const list = await app.inject({ method: "GET", url: "/customers", headers: auth() });
    expect(list.json().data).toHaveLength(1);
  });

  it("the phone of a deleted customer can be reused, and restore then conflicts", async () => {
    const first = await createCustomer({ name: { en: "First", ar: "" }, phone: "0501112222" });
    await app.inject({ method: "DELETE", url: `/customers/${first.id}`, headers: auth() });

    // Partial unique index excludes deleted rows, so this succeeds.
    const second = await createCustomer({ name: { en: "Second", ar: "" }, phone: "0501112222" });
    expect(second.id).not.toBe(first.id);

    // Restoring the first would now violate uniqueness — must be a clean 409.
    const restore = await app.inject({ method: "POST", url: `/customers/${first.id}/restore`, headers: auth() });
    expect(restore.statusCode).toBe(409);
    expect(restore.json().code).toBe("customer-phone-exists");
  });

  it("restoring a customer that is not deleted returns 409", async () => {
    const c = await createCustomer({ name: { en: "Alive", ar: "" }, phone: "0501112222" });
    const res = await app.inject({ method: "POST", url: `/customers/${c.id}/restore`, headers: auth() });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("customer-not-deleted");
  });
});

/* ---------------------------------------------------------------- */

describe("A09: every mutation writes an audit row", () => {
  beforeAll(async () => { await ensureMigrated(); app = await buildApp(); });
  beforeEach(async () => { await truncateAll(); await setup(); });
  afterAll(async () => { await app.close(); await teardown(); });

  async function activityFor(id: number): Promise<string[]> {
    const res = await app.inject({ method: "GET", url: `/customers/${id}/activity`, headers: auth() });
    expect(res.statusCode).toBe(200);
    return (res.json().data as Array<{ action: string }>).map((a) => a.action);
  }

  it("records create, update, status_change, note_add, delete and restore", async () => {
    const c = await createCustomer({ name: { en: "Audited", ar: "مدقق" }, phone: "0501112222" });

    await app.inject({
      method: "PATCH", url: `/customers/${c.id}`, headers: auth(), payload: { vip: true },
    });
    await app.inject({
      method: "POST", url: `/customers/${c.id}/status`, headers: auth(),
      payload: { status: "inactive" },
    });
    await app.inject({
      method: "POST", url: `/customers/${c.id}/notes`, headers: auth(), payload: { body: "A note" },
    });
    await app.inject({ method: "DELETE", url: `/customers/${c.id}`, headers: auth() });
    await app.inject({ method: "POST", url: `/customers/${c.id}/restore`, headers: auth() });

    const actions = await activityFor(c.id);
    expect(actions).toContain("customer.create");
    expect(actions).toContain("customer.update");
    expect(actions).toContain("customer.status_change");
    expect(actions).toContain("customer.note_add");
    expect(actions).toContain("customer.delete");
    expect(actions).toContain("customer.restore");
  });

  it("audit rows carry a readable before/after diff of only changed fields", async () => {
    const c = await createCustomer({ name: { en: "Diffed", ar: "" }, phone: "0501112222" });
    await app.inject({
      method: "PATCH", url: `/customers/${c.id}`, headers: auth(),
      payload: { vip: true, tags: ["corporate"] },
    });

    const res = await app.inject({ method: "GET", url: `/customers/${c.id}/activity`, headers: auth() });
    const update = (res.json().data as Array<{ action: string; before: Record<string, unknown>; after: Record<string, unknown> }>)
      .find((a) => a.action === "customer.update");

    expect(update).toBeDefined();
    expect(update!.after.vip).toBe(true);
    expect(update!.before.vip).toBe(false);
    // Unchanged fields must NOT be in the diff.
    expect(update!.after.phone).toBeUndefined();
    expect(update!.after.name).toBeUndefined();
  });

  it("a no-op PATCH does not create an audit row", async () => {
    const c = await createCustomer({ name: { en: "Same", ar: "" }, phone: "0501112222", vip: false });
    const before = (await activityFor(c.id)).length;

    await app.inject({
      method: "PATCH", url: `/customers/${c.id}`, headers: auth(), payload: { vip: false },
    });

    expect((await activityFor(c.id)).length).toBe(before);
  });
});

/* ---------------------------------------------------------------- */

describe("statistics", () => {
  beforeAll(async () => { await ensureMigrated(); app = await buildApp(); });
  beforeEach(async () => { await truncateAll(); await setup(); });
  afterAll(async () => { await app.close(); await teardown(); });

  it("counts by status, vip and deletion state", async () => {
    const a = await createCustomer({ name: { en: "A", ar: "" }, phone: "0501111111", vip: true });
    await createCustomer({ name: { en: "B", ar: "" }, phone: "0502222222" });
    const c = await createCustomer({ name: { en: "C", ar: "" }, phone: "0503333333" });

    await app.inject({
      method: "POST", url: `/customers/${c.id}/status`, headers: auth(),
      payload: { status: "blocked", reason: "Fraud" },
    });
    await app.inject({ method: "DELETE", url: `/customers/${a.id}`, headers: auth() });

    const res = await app.inject({ method: "GET", url: "/customers/statistics", headers: auth() });
    expect(res.statusCode).toBe(200);
    const s = res.json().statistics;

    expect(s.total).toBe(2);       // a is deleted
    expect(s.active).toBe(1);      // b
    expect(s.blocked).toBe(1);     // c
    expect(s.deleted).toBe(1);     // a
    expect(s.vip).toBe(0);         // a was the vip and is deleted
  });
});
