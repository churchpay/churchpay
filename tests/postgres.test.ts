import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { Pool } from "pg";
import {
  paymentsToReconcile,
  postgresStore,
  rateLimit,
  type Payment,
} from "../lib/payment-store";
import { migrateDatabase } from "../lib/migrations";

test(
  "PostgreSQL persists capture state and excludes concurrent workers",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      max: 3,
    });
    const reference = {
      domain: `test-${randomUUID()}`,
      groupId: "10",
      personId: "20",
    };
    try {
      await migrateDatabase(pool);
      const store = postgresStore(pool);
      await Promise.all([
        rateLimit(reference.domain, 2, pool),
        rateLimit(reference.domain, 2, pool),
      ]);
      await assert.rejects(rateLimit(reference.domain, 2, pool));
      const payment: Payment = {
        ...reference,
        id: randomUUID(),
        amountCents: 6900,
        paidFieldId: 5,
        status: "capturing",
        orderId: `ORDER${Date.now()}`,
        captureId: null,
        captureRequested: true,
        synced: false,
        createdAt: Date.now(),
        paidAt: null,
        checkedAt: null,
      };
      await store.withLock(reference, async (session) => {
        assert.equal(await session.get(), null);
        await session.save(payment);
        await assert.rejects(session.save({ ...payment, id: randomUUID() }));
        await assert.rejects(
          store.withLock(reference, async () =>
            assert.fail("concurrent worker acquired the lock"),
          ),
        );
        await assert.rejects(session.save({ ...payment, personId: "21" }));
      });
      // A new pool represents a different process, not an in-memory cache.
      const secondPool = new Pool({
        connectionString: process.env.TEST_DATABASE_URL,
        max: 1,
      });
      try {
        await assert.rejects(
          postgresStore(secondPool).withLock(reference, async (session) => {
            const recovered = await session.get();
            assert.equal(recovered?.captureRequested, true);
            assert.equal(recovered?.status, "capturing");
            assert.equal(recovered?.amountCents, 6900);
            await session.save({
              ...recovered!,
              status: "completed",
              captureId: `CAPTURE${Date.now()}`,
            });
            throw new Error("process failed after durable write");
          }),
        );
        await store.withLock(reference, async (session) => {
          assert.equal((await session.get())?.status, "completed");
        });
      } finally {
        await secondPool.end();
      }
      await pool.query("DELETE FROM churchpay_payments WHERE domain=$1", [
        reference.domain,
      ]);
    } finally {
      await pool.end();
    }
  },
);

test(
  "reconciliation stops settled checks at 30 days and spaces unsettled checks by 15 minutes",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: "-c timezone=Europe/Berlin",
    });
    const domain = `test-${randomUUID()}`;
    // Cross a DST change: 30 calendar days in a database timezone can exceed
    // the maximum 30 * 24 elapsed hours requested for settled payments.
    const now = Date.parse("2026-11-09T12:00:00Z");
    const minute = 60000,
      day = 86400000;
    const expected: string[] = [];
    let person = 0;
    try {
      await migrateDatabase(pool);
      const store = postgresStore(pool);
      const add = async (patch: Partial<Payment>, included: boolean) => {
        const payment: Payment = {
          id: randomUUID(),
          domain,
          groupId: "10",
          personId: String(++person),
          amountCents: 6900,
          paidFieldId: 5,
          status: "completed",
          orderId: null,
          captureId: null,
          captureRequested: true,
          synced: true,
          createdAt: now - 40 * day,
          paidAt: now - 2 * day,
          checkedAt: now - 6 * 60 * minute,
          ...patch,
        };
        await store.withLock(payment, (session) => session.save(payment));
        if (included) expected.push(payment.personId);
      };
      for (const status of ["completed", "refunded", "reversed"] as const) {
        await add({ status, paidAt: now - 29 * day }, true);
        await add({ status, paidAt: now - 30 * day }, false);
        await add({ status, paidAt: now - 31 * day, checkedAt: null }, false);
      }
      await add({}, true); // A late capture is bounded by payment time, not order creation.
      await add({ checkedAt: now - 5 * 60 * minute }, false);
      await add(
        {
          status: "pending",
          synced: false,
          paidAt: now - 40 * day,
          checkedAt: now - 15 * minute,
        },
        true,
      );
      await add(
        { status: "pending", synced: false, checkedAt: now - 14 * minute },
        false,
      );
      await add(
        { synced: false, paidAt: now - 40 * day, checkedAt: now - 15 * minute },
        true,
      );
      await add({ paidAt: null, createdAt: now - 29 * day }, true);
      await add({ paidAt: null, createdAt: now - 31 * day }, false);
      const selected = (await paymentsToReconcile(100, pool, now))
        .filter((payment) => payment.domain === domain)
        .map((payment) => payment.personId)
        .sort();
      assert.deepEqual(selected, expected.sort());
    } finally {
      await pool.query("DELETE FROM churchpay_payments WHERE domain=$1", [
        domain,
      ]);
      await pool.end();
    }
  },
);

test(
  "payment-time migration upgrades old records idempotently without extending their cutoff",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    const schema = `review_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    try {
      await pool.query(await readFile("migrations/001_payments.sql", "utf8"));
      const created = new Date(Date.now() - 40 * 86400000);
      await pool.query(
        "INSERT INTO churchpay_payments (id,domain,group_id,person_id,amount_cents,paid_field_id,status,capture_id,synced,created_at) VALUES ($1,'demo','1','2',6900,5,'completed','OLD_CAPTURE',true,$2)",
        [randomUUID(), created],
      );
      await migrateDatabase(pool);
      const first = (await pool.query("SELECT paid_at FROM churchpay_payments"))
        .rows[0].paid_at;
      assert.equal(first.getTime(), created.getTime());
      await pool.query(
        "UPDATE churchpay_payments SET updated_at=now(), checked_at=now()",
      );
      await migrateDatabase(pool);
      assert.equal(
        (
          await pool.query("SELECT paid_at FROM churchpay_payments")
        ).rows[0].paid_at.getTime(),
        first.getTime(),
      );
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
