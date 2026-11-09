import { createHash } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { z } from "zod";
import { referenceSchema, type PaymentReference } from "./config";

export const paymentSchema = referenceSchema.extend({
  id: z.uuid(),
  amountCents: z.number().int().positive(),
  paidFieldId: z.number().int().positive(),
  status: z.enum([
    "creating",
    "created",
    "capturing",
    "pending",
    "completed",
    "refunded",
    "reversed",
    "review",
  ]),
  orderId: z.string().nullable(),
  captureId: z.string().nullable(),
  captureRequested: z.boolean(),
  synced: z.boolean(),
  createdAt: z.number(),
  paidAt: z.number().nullable(),
  checkedAt: z.number().nullable(),
});
export type Payment = z.infer<typeof paymentSchema>;
export interface PaymentSession {
  get(): Promise<Payment | null>;
  save(payment: Payment): Promise<void>;
}
export interface PaymentStore {
  withLock<T>(
    reference: PaymentReference,
    work: (session: PaymentSession) => Promise<T>,
  ): Promise<T>;
}

let pool: Pool | undefined;
export function database() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 5,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 10000,
      statement_timeout: 10000,
      allowExitOnIdle: true,
    });
    pool.on("error", () =>
      console.error(JSON.stringify({ event: "database_connection_failed" })),
    );
  }
  return pool;
}

const columns = `id, domain, group_id AS "groupId", person_id AS "personId", amount_cents AS "amountCents", paid_field_id AS "paidFieldId", status, order_id AS "orderId", capture_id AS "captureId", capture_requested AS "captureRequested", synced, extract(epoch FROM created_at)::float8 * 1000 AS "createdAt", extract(epoch FROM paid_at)::float8 * 1000 AS "paidAt", extract(epoch FROM checked_at)::float8 * 1000 AS "checkedAt"`;
export function referenceKey(reference: PaymentReference) {
  referenceSchema.parse(reference);
  return JSON.stringify([
    reference.domain,
    reference.groupId,
    reference.personId,
  ]);
}

class PostgresSession implements PaymentSession {
  constructor(
    private client: PoolClient,
    private reference: PaymentReference,
  ) {}
  async get() {
    const result = await this.client.query(
      `SELECT ${columns} FROM churchpay_payments WHERE domain=$1 AND group_id=$2 AND person_id=$3`,
      [this.reference.domain, this.reference.groupId, this.reference.personId],
    );
    return result.rows.length ? paymentSchema.parse(result.rows[0]) : null;
  }
  async save(payment: Payment) {
    paymentSchema.parse(payment);
    if (referenceKey(payment) !== referenceKey(this.reference))
      throw new Error("Payment reference mismatch");
    // Each state is committed before the next external side effect. A rollback
    // must never erase evidence of a capture that PayPal may have completed.
    const result = await this.client.query(
      `INSERT INTO churchpay_payments (id,domain,group_id,person_id,amount_cents,paid_field_id,status,order_id,capture_id,capture_requested,synced,created_at,checked_at,paid_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,to_timestamp($12/1000.0),to_timestamp($13::float8/1000.0),to_timestamp($14::float8/1000.0))
      ON CONFLICT (domain,group_id,person_id) DO UPDATE SET status=EXCLUDED.status, order_id=EXCLUDED.order_id, capture_id=EXCLUDED.capture_id, capture_requested=EXCLUDED.capture_requested, synced=EXCLUDED.synced, paid_at=COALESCE(churchpay_payments.paid_at,EXCLUDED.paid_at), checked_at=EXCLUDED.checked_at, updated_at=now()
      WHERE churchpay_payments.id=EXCLUDED.id`,
      [
        payment.id,
        payment.domain,
        payment.groupId,
        payment.personId,
        payment.amountCents,
        payment.paidFieldId,
        payment.status,
        payment.orderId,
        payment.captureId,
        payment.captureRequested,
        payment.synced,
        payment.createdAt,
        payment.checkedAt,
        payment.paidAt,
      ],
    );
    if (result.rowCount !== 1) throw new Error("Payment record changed");
  }
}

export function postgresStore(db = database()): PaymentStore {
  return {
    async withLock(reference, work) {
      const key = referenceKey(reference);
      const client = await db.connect();
      let locked = false;
      let releaseError: Error | undefined;
      try {
        const result = await client.query(
          "SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked",
          [key],
        );
        locked = result.rows[0].locked;
        if (!locked)
          throw new Error("Payment is being processed; retry shortly");
        return await work(new PostgresSession(client, reference));
      } finally {
        if (locked) {
          try {
            await client.query(
              "SELECT pg_advisory_unlock(hashtextextended($1,0))",
              [key],
            );
          } catch {
            releaseError = new Error("Failed to release payment lock");
          }
        }
        client.release(releaseError);
      }
    },
  };
}

export async function rateLimit(key: string, limit: number, db = database()) {
  const hash = createHash("sha256").update(key).digest("hex");
  const bucket = Math.floor(Date.now() / 60000);
  const result = await db.query(
    "INSERT INTO churchpay_rate_limits (key,bucket,count) VALUES ($1,$2,1) ON CONFLICT (key,bucket) DO UPDATE SET count=churchpay_rate_limits.count+1 RETURNING count",
    [hash, bucket],
  );
  if (result.rows[0].count > limit)
    throw new Error("Too many payment requests");
}

export async function findWebhookPayment(
  domain: string,
  orderId?: string,
  captureId?: string,
) {
  const result = await database().query(
    `SELECT ${columns} FROM churchpay_payments WHERE domain=$1 AND (order_id=$2 OR capture_id=$3)`,
    [domain, orderId ?? null, captureId ?? null],
  );
  return result.rows.length ? paymentSchema.parse(result.rows[0]) : null;
}

export async function paymentsToReconcile(
  limit = 100,
  db = database(),
  now = Date.now(),
) {
  const result = await db.query(
    `SELECT ${columns} FROM churchpay_payments
     WHERE (NOT (synced AND status IN ('completed','refunded','reversed'))
       OR COALESCE(paid_at,created_at) > to_timestamp($2::float8/1000.0) - interval '720 hours')
       AND (checked_at IS NULL OR checked_at <= to_timestamp($2::float8/1000.0) - CASE
         WHEN synced AND status IN ('completed','refunded','reversed') THEN interval '6 hours'
         ELSE interval '15 minutes' END)
     ORDER BY checked_at NULLS FIRST LIMIT $1`,
    [limit, now],
  );
  return result.rows.map((row) => paymentSchema.parse(row));
}
