import { randomUUID } from "node:crypto";
import type { PaymentReference } from "./config";
import { formatPayPalAmount } from "./money";
import type { Payment, PaymentSession, PaymentStore } from "./payment-store";
import type { PayPalCapture, PayPalGateway, PayPalOrder } from "./paypal";
import type { PaymentInfo, PaymentResult, PaymentStatus, Quote } from "./types";

export interface PaymentDependencies {
  store: PaymentStore;
  paypal: PayPalGateway;
  quote(reference: PaymentReference): Promise<Quote>;
  setPaid(
    reference: PaymentReference,
    fieldId: number,
    paid: boolean,
  ): Promise<void>;
  merchantId: string;
  clientId: string;
  now?: () => number;
  log?: (event: string, paymentId: string) => void;
}

export class PaymentService {
  private now: () => number;
  constructor(private deps: PaymentDependencies) {
    this.now = deps.now ?? Date.now;
  }

  private result(payment: Payment): PaymentResult {
    return { type: "status", status: payment.status, synced: payment.synced };
  }

  async info(reference: PaymentReference): Promise<PaymentInfo> {
    return this.deps.store.withLock(reference, async (session) => {
      const payment = await session.get();
      if (payment && !["creating", "created"].includes(payment.status))
        return this.refresh(payment, session);
      const quote = await this.deps.quote(reference);
      if (
        payment &&
        (payment.amountCents !== quote.amountCents ||
          payment.paidFieldId !== quote.paidFieldId)
      ) {
        payment.status = "review";
        await session.save(payment);
        return this.result(payment);
      }
      if (quote.paid)
        return { type: "status", status: "completed", synced: true };
      return {
        type: "data",
        groupName: quote.groupName,
        amountCents: quote.amountCents,
        clientId: this.deps.clientId,
      };
    });
  }

  async create(
    reference: PaymentReference,
  ): Promise<{ type: "order"; orderId: string } | PaymentResult> {
    return this.deps.store.withLock(reference, async (session) => {
      let payment = await session.get();
      if (payment && !["creating", "created"].includes(payment.status))
        return this.refresh(payment, session);
      const quote = await this.deps.quote(reference);
      if (quote.paid)
        return { type: "status", status: "completed", synced: true };
      if (!payment) {
        payment = {
          ...reference,
          id: randomUUID(),
          amountCents: quote.amountCents,
          paidFieldId: quote.paidFieldId,
          status: "creating",
          orderId: null,
          captureId: null,
          captureRequested: false,
          synced: false,
          createdAt: this.now(),
          checkedAt: null,
        };
        await session.save(payment);
      }
      // PayPal retains create idempotency keys for at least six hours. Once a
      // response is ambiguous beyond that window, require operator review.
      if (
        (!payment.orderId &&
          this.now() - payment.createdAt > 5 * 60 * 60 * 1000) ||
        payment.amountCents !== quote.amountCents ||
        payment.paidFieldId !== quote.paidFieldId
      ) {
        payment.status = "review";
        await session.save(payment);
        return this.result(payment);
      }
      if (payment.orderId) {
        const result = await this.refresh(payment, session);
        return result.status === "created"
          ? { type: "order", orderId: payment.orderId }
          : result;
      }
      payment.orderId = await this.deps.paypal.create(payment, quote);
      payment.status = "created";
      await session.save(payment);
      return { type: "order", orderId: payment.orderId };
    });
  }

  async capture(
    reference: PaymentReference,
    orderId: string,
  ): Promise<PaymentResult> {
    return this.deps.store.withLock(reference, async (session) => {
      const payment = await session.get();
      if (!payment || payment.orderId !== orderId)
        throw new Error("Order does not belong to this registration");
      if (payment.status === "review") return this.result(payment);
      return this.refresh(payment, session, true);
    });
  }

  async reconcile(reference: PaymentReference): Promise<PaymentResult | null> {
    return this.deps.store.withLock(reference, async (session) => {
      const payment = await session.get();
      if (!payment) return null;
      if (payment.orderId) return this.refresh(payment, session);
      if (this.now() - payment.createdAt > 5 * 60 * 60 * 1000)
        payment.status = "review";
      payment.checkedAt = this.now();
      await session.save(payment);
      if (payment.status === "review")
        this.deps.log?.("payment_requires_review", payment.id);
      return this.result(payment);
    });
  }

  // Called only after PayPal has verified the webhook signature. A reversal
  // notification can arrive before the capture-details API reflects it.
  async recordReversal(reference: PaymentReference, captureId: string) {
    return this.deps.store.withLock(reference, async (session) => {
      const payment = await session.get();
      if (!payment?.orderId) throw new Error("Unknown reversal");
      const order = await this.deps.paypal.read(payment.orderId);
      this.verifyOrder(payment, order);
      const captures = order.purchaseUnits[0].payments?.captures ?? [];
      if (
        captures.length !== 1 ||
        captures[0].id !== captureId ||
        (payment.captureId && payment.captureId !== captureId)
      )
        throw new Error("Reversal capture mismatch");
      this.verifyCapture(
        payment,
        await this.deps.paypal.readCapture(captureId),
        captureId,
      );
      if (payment.status !== "reversed") payment.synced = false;
      payment.status = "reversed";
      payment.captureId = captureId;
      payment.checkedAt = this.now();
      await session.save(payment);
      return this.synchronize(payment, session);
    });
  }

  private verifyOrder(payment: Payment, order: PayPalOrder) {
    const unit = order.purchaseUnits[0];
    if (
      order.id !== payment.orderId ||
      order.intent !== "CAPTURE" ||
      order.purchaseUnits.length !== 1 ||
      unit.customId !== payment.id ||
      unit.invoiceId !== `churchpay-${payment.id}` ||
      unit.payee.merchantId !== this.deps.merchantId ||
      unit.amount.currencyCode !== "EUR" ||
      unit.amount.value !== formatPayPalAmount(payment.amountCents)
    )
      throw new Error("PayPal order verification failed");
  }

  private verifyCapture(
    payment: Payment,
    capture: PayPalCapture,
    captureId: string,
  ) {
    if (
      capture.id !== captureId ||
      capture.amount.currencyCode !== "EUR" ||
      capture.amount.value !== formatPayPalAmount(payment.amountCents) ||
      !capture.finalCapture
    )
      throw new Error("PayPal capture verification failed");
  }

  private async refresh(
    payment: Payment,
    session: PaymentSession,
    requestCapture = false,
  ): Promise<PaymentResult> {
    if (!payment.orderId) return this.result(payment);
    let order = await this.deps.paypal.read(payment.orderId);
    this.verifyOrder(payment, order);
    let captures = order.purchaseUnits[0].payments?.captures ?? [];
    if (
      !captures.length &&
      order.status === "APPROVED" &&
      (requestCapture || payment.captureRequested) &&
      payment.status !== "review"
    ) {
      const quote = await this.deps.quote(payment);
      if (
        quote.paid ||
        quote.amountCents !== payment.amountCents ||
        quote.paidFieldId !== payment.paidFieldId
      ) {
        payment.status = "review";
        await session.save(payment);
        return this.result(payment);
      }
      payment.captureRequested = true;
      payment.status = "capturing";
      await session.save(payment);
      await this.deps.paypal.capture(payment.orderId, `${payment.id}-capture`);
      order = await this.deps.paypal.read(payment.orderId);
      this.verifyOrder(payment, order);
      captures = order.purchaseUnits[0].payments?.captures ?? [];
    }
    if (!captures.length) {
      if (
        order.status === "VOIDED" ||
        (order.status === "CREATED" &&
          this.now() - payment.createdAt > 6 * 60 * 60 * 1000)
      )
        payment.status = "review";
      payment.checkedAt = this.now();
      await session.save(payment);
      return this.result(payment);
    }
    if (
      captures.length !== 1 ||
      (payment.captureId && payment.captureId !== captures[0].id)
    )
      throw new Error("Unexpected PayPal capture");
    const capture = await this.deps.paypal.readCapture(captures[0].id);
    this.verifyCapture(payment, capture, captures[0].id);
    const statuses: Record<string, PaymentStatus> = {
      COMPLETED: "completed",
      PENDING: "pending",
      REFUNDED: "refunded",
      REVERSED: "reversed",
    };
    const status = ["refunded", "reversed"].includes(payment.status)
      ? payment.status
      : (statuses[capture.status] ?? "review");
    if (status !== payment.status) payment.synced = false;
    payment.status = status;
    payment.captureId = capture.id;
    payment.checkedAt = this.now();
    await session.save(payment);
    return this.synchronize(payment, session);
  }

  private async synchronize(payment: Payment, session: PaymentSession) {
    const status = payment.status;
    if (
      ["completed", "refunded", "reversed"].includes(status) &&
      !payment.synced
    ) {
      try {
        await this.deps.setPaid(
          payment,
          payment.paidFieldId,
          status === "completed",
        );
        payment.synced = true;
        await session.save(payment);
      } catch {
        this.deps.log?.("churchtools_sync_failed", payment.id);
      }
    }
    if (status === "review")
      this.deps.log?.("payment_requires_review", payment.id);
    return this.result(payment);
  }
}
