/**
 * A04 + A09: Append-only trigger enforcement.
 *
 * The activity_logs table is append-only in Postgres itself — a trigger
 * raises an exception on UPDATE or DELETE. This test proves the trigger
 * fires. Without it, the "immutable audit trail" claim in SECURITY.md
 * would be a wish rather than a control.
 *
 * A regression would look like: someone drops the trigger, no error, tests
 * still pass. This test would catch that immediately.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { db, withNoTenant } from "../../src/lib/db.js";
import { ensureMigrated, teardown, truncateAll } from "../helpers/harness.js";

async function seedBusinessAndLog(): Promise<{ businessId: number; logId: number }> {
  return withNoTenant(async (trx) => {
    const biz = await trx.insertInto("businesses")
      .values({ name: { en: "Append Test", ar: "إلحاق" } as never })
      .returning("id")
      .executeTakeFirstOrThrow();

    // Insert directly; disable RLS check for the setup by using the app.business_id
    // set to the same value.
    await sql`SET LOCAL app.business_id = ${sql.lit(biz.id)}`.execute(trx);

    const log = await trx.insertInto("activity_logs")
      .values({
        business_id: biz.id,
        action: "test.insert",
        resource_type: "test",
        resource_id: 1,
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    return { businessId: biz.id, logId: log.id };
  });
}

describe("A04 + A09: activity_logs is append-only", () => {
  beforeAll(async () => { await ensureMigrated(); });
  beforeEach(async () => { await truncateAll(); });
  afterAll(async () => { await teardown(); });

  it("INSERT succeeds (baseline: the table works)", async () => {
    const { logId } = await seedBusinessAndLog();
    expect(logId).toBeGreaterThan(0);
  });

  it("UPDATE on activity_logs is rejected by trigger", async () => {
    const { businessId, logId } = await seedBusinessAndLog();

    await expect(
      withNoTenant(async (trx) => {
        await sql`SET LOCAL app.business_id = ${sql.lit(businessId)}`.execute(trx);
        await trx.updateTable("activity_logs")
          .set({ action: "test.modified" })
          .where("id", "=", logId)
          .execute();
      }),
    ).rejects.toThrow(/append-only|restrict/i);
  });

  it("DELETE on activity_logs is rejected by trigger", async () => {
    const { businessId, logId } = await seedBusinessAndLog();

    await expect(
      withNoTenant(async (trx) => {
        await sql`SET LOCAL app.business_id = ${sql.lit(businessId)}`.execute(trx);
        await trx.deleteFrom("activity_logs")
          .where("id", "=", logId)
          .execute();
      }),
    ).rejects.toThrow(/append-only|restrict/i);
  });

  it("multiple INSERTs into activity_logs all succeed (append is unrestricted)", async () => {
    const { businessId } = await seedBusinessAndLog();

    await withNoTenant(async (trx) => {
      await sql`SET LOCAL app.business_id = ${sql.lit(businessId)}`.execute(trx);
      for (let i = 0; i < 5; i++) {
        await trx.insertInto("activity_logs")
          .values({
            business_id: businessId,
            action: `test.append.${i}`,
            resource_type: "test",
            resource_id: i,
          })
          .execute();
      }
    });

    const count = await db.selectFrom("activity_logs")
      .select(db.fn.count("id").as("n"))
      .where("business_id", "=", businessId)
      .executeTakeFirstOrThrow();

    // 1 from seedBusinessAndLog + 5 more = 6.
    expect(Number(count.n)).toBe(6);
  });
});
