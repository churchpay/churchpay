import { database, paymentsToReconcile } from "./payment-store";
import { paymentService } from "./payments";

export async function reconcilePayments() {
  const payments = await paymentsToReconcile();
  let failures = 0;
  let review = 0;
  for (const payment of payments) {
    try {
      const result = await paymentService(payment.domain).reconcile(payment);
      if (result?.status === "review") review++;
      if (
        result &&
        ["completed", "refunded", "reversed"].includes(result.status) &&
        !result.synced
      )
        failures++;
    } catch {
      failures++;
      // Move failed checks to the back of the queue so one unavailable tenant
      // cannot indefinitely starve all other payments.
      await database().query(
        "UPDATE churchpay_payments SET checked_at=now() WHERE id=$1",
        [payment.id],
      );
      console.error(
        JSON.stringify({
          event: "payment_reconcile_failed",
          paymentId: payment.id,
        }),
      );
    }
  }
  await database().query(
    "DELETE FROM churchpay_rate_limits WHERE bucket < $1",
    [Math.floor(Date.now() / 60000) - 2],
  );
  return { checked: payments.length, failures, review };
}
