import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("Vercel Hobby deploys a 15-minute Schedule to the authenticated GET endpoint", async () => {
  const config = JSON.parse(await readFile("vercel.json", "utf8"));
  assert.equal(config.crons, undefined);
  assert.deepEqual(config.schedules["payment-reconciliation"], {
    schedule: "*/15 * * * *",
    timezone: "UTC",
    jitter: 15,
    path: "/api/reconcile",
    requestMethod: "GET",
  });
});
