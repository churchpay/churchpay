import assert from "node:assert/strict";
import { test } from "node:test";
import { PaymentService } from "../lib/payment-service";
import type { Payment, PaymentStore } from "../lib/payment-store";
import type { PayPalCapture, PayPalGateway, PayPalOrder } from "../lib/paypal";

const reference = { domain: "demo", groupId: "10", personId: "20" };
function fixture() {
  let payment: Payment | null = null;
  let locked = false;
  const saved: Payment[] = [];
  const store: PaymentStore = {
    async withLock(_reference, work) {
      if (locked) throw new Error("locked");
      locked = true;
      try {
        return await work({
          get: async () => structuredClone(payment),
          save: async (value) => {
            payment = structuredClone(value);
            saved.push(structuredClone(value));
          },
        });
      } finally {
        locked = false;
      }
    },
  };
  const state = {
    amountCents: 6900,
    paid: false,
    syncFails: false,
    timeoutAfterCapture: false,
    createThrows: false,
    captureStatus: "COMPLETED",
    creates: 0,
    captures: 0,
    syncs: [] as boolean[],
    order: null as PayPalOrder | null,
    capture: null as PayPalCapture | null,
    now: Date.now(),
  };
  const paypal: PayPalGateway = {
    async create(value, quote) {
      assert.equal(quote.groupName, "Real group");
      assert.equal(quote.personName, "Test Participant");
      state.creates++;
      state.order = {
        id: "ORDER1",
        status: "APPROVED",
        intent: "CAPTURE",
        purchaseUnits: [
          {
            customId: value.id,
            invoiceId: `churchpay-${value.id}`,
            amount: { currencyCode: "EUR", value: "69.00" },
            payee: { merchantId: "MERCHANT" },
          },
        ],
      };
      if (state.createThrows) throw new Error("lost create response");
      return "ORDER1";
    },
    async read() {
      return structuredClone(state.order!);
    },
    async capture(_orderId, requestId) {
      assert.equal(saved.at(-1)?.captureRequested, true);
      assert(requestId.endsWith("-capture"));
      state.captures++;
      state.order!.status = "COMPLETED";
      state.order!.purchaseUnits[0].payments = {
        captures: [{ id: "CAPTURE1" }],
      };
      state.capture = {
        id: "CAPTURE1",
        status: state.captureStatus,
        amount: { currencyCode: "EUR", value: "69.00" },
        finalCapture: true,
      };
      if (state.timeoutAfterCapture)
        throw new Error("response lost after capture");
    },
    async readCapture() {
      return structuredClone(state.capture!);
    },
  };
  const service = new PaymentService({
    store,
    paypal,
    quote: async () => ({
      groupName: "Real group",
      personName: "Test Participant",
      amountCents: state.amountCents,
      paidFieldId: 5,
      paid: state.paid,
    }),
    setPaid: async (_ref, id, paid) => {
      assert.equal(id, 5);
      assert(
        ["completed", "refunded", "reversed"].includes(saved.at(-1)!.status),
      );
      if (state.syncFails) throw new Error("ChurchTools unavailable");
      state.syncs.push(paid);
      state.paid = paid;
    },
    merchantId: "MERCHANT",
    clientId: "PUBLIC_CLIENT",
    now: () => state.now,
  });
  return { service, state, saved, payment: () => payment };
}

test("one registration reuses its order and repeated captures do not charge twice", async () => {
  const f = fixture();
  const info = await f.service.info(reference);
  assert.equal(info.type, "data");
  assert.equal("personName" in info, false);
  assert.deepEqual(
    await f.service.create(reference),
    await f.service.create(reference),
  );
  assert.equal(f.state.creates, 1);
  assert.deepEqual(await f.service.capture(reference, "ORDER1"), {
    type: "status",
    status: "completed",
    synced: true,
  });
  await f.service.capture(reference, "ORDER1");
  assert.equal(f.state.captures, 1);
  assert.deepEqual(f.state.syncs, [true]);
});

test("reject an order belonging to another registration before calling PayPal", async () => {
  const f = fixture();
  await f.service.create(reference);
  await assert.rejects(f.service.capture(reference, "OTHERORDER"));
  assert.equal(f.state.captures, 0);
});

for (const mutation of [
  "custom",
  "invoice",
  "merchant",
  "amount",
  "currency",
  "order",
  "intent",
  "units",
] as const) {
  test(`reject mismatched PayPal ${mutation} before charging`, async () => {
    const f = fixture();
    await f.service.create(reference);
    const order = f.state.order!;
    const unit = order.purchaseUnits[0];
    if (mutation === "custom") unit.customId = "another-registration";
    if (mutation === "invoice") unit.invoiceId = "another-invoice";
    if (mutation === "merchant") unit.payee.merchantId = "OTHER";
    if (mutation === "amount") unit.amount.value = "0.01";
    if (mutation === "currency") unit.amount.currencyCode = "USD";
    if (mutation === "order") order.id = "OTHERORDER";
    if (mutation === "intent")
      (order as { intent: string }).intent = "AUTHORIZE";
    if (mutation === "units") order.purchaseUnits.push(structuredClone(unit));
    await assert.rejects(f.service.capture(reference, "ORDER1"));
    assert.equal(f.state.captures, 0);
    assert.deepEqual(f.state.syncs, []);
  });
}

test("pending capture is not paid; later completion is reconciled", async () => {
  const f = fixture();
  f.state.captureStatus = "PENDING";
  await f.service.create(reference);
  assert.deepEqual(await f.service.capture(reference, "ORDER1"), {
    type: "status",
    status: "pending",
    synced: false,
  });
  assert.deepEqual(f.state.syncs, []);
  f.state.capture!.status = "COMPLETED";
  await f.service.reconcile(reference);
  assert.deepEqual(f.state.syncs, [true]);
  assert.equal(f.state.captures, 1);
});

test("successful capture survives ChurchTools failure and retries only synchronization", async () => {
  const f = fixture();
  f.state.syncFails = true;
  await f.service.create(reference);
  assert.deepEqual(await f.service.capture(reference, "ORDER1"), {
    type: "status",
    status: "completed",
    synced: false,
  });
  assert.equal(f.payment()!.status, "completed");
  f.state.syncFails = false;
  await f.service.capture(reference, "ORDER1");
  assert.equal(f.state.captures, 1);
  assert.deepEqual(f.state.syncs, [true]);
});

test("lost capture response is recovered from authoritative PayPal state", async () => {
  const f = fixture();
  f.state.timeoutAfterCapture = true;
  await f.service.create(reference);
  await assert.rejects(f.service.capture(reference, "ORDER1"));
  assert.equal(f.payment()!.captureRequested, true);
  await f.service.reconcile(reference);
  assert.equal(f.state.captures, 1);
  assert.deepEqual(f.state.syncs, [true]);
});

test("approval alone does not authorize a background capture", async () => {
  const f = fixture();
  await f.service.create(reference);
  await f.service.reconcile(reference);
  assert.equal(f.state.captures, 0);
});

test("changed prices and already paid registrations are not charged", async () => {
  for (const change of ["amount", "paid"]) {
    const f = fixture();
    await f.service.create(reference);
    if (change === "amount") f.state.amountCents = 7000;
    else f.state.paid = true;
    assert.equal(
      (await f.service.capture(reference, "ORDER1")).status,
      "review",
    );
    assert.equal(f.state.captures, 0);
  }
});

test("full refunds and reversals update ChurchTools without enabling another charge", async () => {
  for (const status of ["REFUNDED", "REVERSED"]) {
    const f = fixture();
    await f.service.create(reference);
    await f.service.capture(reference, "ORDER1");
    f.state.capture!.status = status;
    await f.service.reconcile(reference);
    assert.deepEqual(f.state.syncs, [true, false]);
    assert.equal((await f.service.create(reference)).type, "status");
    assert.equal(f.state.creates, 1);
    assert.equal(f.state.captures, 1);
  }
});

test("partial refunds require review instead of guessing a boolean payment state", async () => {
  const f = fixture();
  await f.service.create(reference);
  await f.service.capture(reference, "ORDER1");
  f.state.capture!.status = "PARTIALLY_REFUNDED";
  assert.equal((await f.service.reconcile(reference))!.status, "review");
  assert.deepEqual(f.state.syncs, [true]);
});

test("a verified reversal stays reversed when the capture-details API is stale", async () => {
  const f = fixture();
  await f.service.create(reference);
  await f.service.capture(reference, "ORDER1");
  await assert.rejects(f.service.recordReversal(reference, "OTHER_CAPTURE"));
  assert.deepEqual(f.state.syncs, [true]);
  await f.service.recordReversal(reference, "CAPTURE1");
  assert.deepEqual(f.state.syncs, [true, false]);
  assert.equal((await f.service.reconcile(reference))!.status, "reversed");
  assert.deepEqual(f.state.syncs, [true, false]);
});

test("ambiguous create requests are not retried beyond PayPal's idempotency window", async () => {
  const f = fixture();
  f.state.createThrows = true;
  await assert.rejects(f.service.create(reference));
  assert.equal(f.payment()!.orderId, null);
  f.state.now += 6 * 60 * 60 * 1000;
  assert.equal((await f.service.reconcile(reference))!.status, "review");
  assert.equal((await f.service.create(reference)).type, "status");
  assert.equal(f.state.creates, 1);
});

test("existing orders are held for review when their quoted amount changes", async () => {
  const f = fixture();
  await f.service.create(reference);
  f.state.amountCents = 7000;
  const info = await f.service.info(reference);
  assert.equal(info.type, "status");
  assert.equal((await f.service.create(reference)).type, "status");
  assert.equal(f.state.creates, 1);
});

for (const mutation of ["amount", "currency", "partial", "id"] as const) {
  test(`invalid capture ${mutation} never marks a registration paid`, async () => {
    const f = fixture();
    await f.service.create(reference);
    f.state.order!.status = "COMPLETED";
    f.state.order!.purchaseUnits[0].payments = {
      captures: [{ id: "CAPTURE1" }],
    };
    f.state.capture = {
      id: "CAPTURE1",
      status: "COMPLETED",
      amount: { currencyCode: "EUR", value: "69.00" },
      finalCapture: true,
    };
    if (mutation === "amount") f.state.capture.amount.value = "0.01";
    if (mutation === "currency") f.state.capture.amount.currencyCode = "USD";
    if (mutation === "partial") f.state.capture.finalCapture = false;
    if (mutation === "id") f.state.capture.id = "OTHER_CAPTURE";
    await assert.rejects(f.service.capture(reference, "ORDER1"));
    assert.deepEqual(f.state.syncs, []);
  });
}
