import { z } from "zod";
import { getTenant } from "@/lib/config";
import { findWebhookPayment, rateLimit } from "@/lib/payment-store";
import { paymentService } from "@/lib/payments";
import { verifyWebhook } from "@/lib/paypal";

export const runtime = "nodejs";
export const maxDuration = 120;
const eventSchema = z.object({
  id: z.string().min(1),
  event_type: z.string(),
  resource: z
    .object({
      id: z
        .string()
        .regex(/^[A-Z0-9]{1,36}$/)
        .optional(),
      supplementary_data: z
        .object({
          related_ids: z.object({
            order_id: z.string().regex(/^[A-Z0-9]{1,36}$/),
          }),
        })
        .optional(),
    })
    .passthrough(),
});

export async function POST(
  request: Request,
  context: { params: Promise<{ domain: string }> },
) {
  try {
    const tenant = getTenant((await context.params).domain);
    await rateLimit(`webhook:${tenant.domain}`, 600);
    // Bound streamed bodies as well as Content-Length; no certificate URLs are fetched locally.
    const reader = request.body?.getReader();
    if (!reader) return new Response(null, { status: 400 });
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 262144) {
        await reader.cancel();
        return new Response(null, { status: 413 });
      }
      chunks.push(value);
    }
    const raw: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    await verifyWebhook(tenant, request.headers, raw);
    const event = eventSchema.parse(raw);
    if (!event.event_type.startsWith("PAYMENT.CAPTURE."))
      return new Response(null, { status: 204 });
    const orderId = event.resource.supplementary_data?.related_ids.order_id;
    if (orderId || event.resource.id) {
      const payment = await findWebhookPayment(
        tenant.domain,
        orderId,
        event.resource.id,
      );
      if (payment) {
        const service = paymentService(tenant.domain);
        const result =
          event.event_type === "PAYMENT.CAPTURE.REVERSED" && event.resource.id
            ? await service.recordReversal(payment, event.resource.id)
            : await service.reconcile(payment);
        if (
          result &&
          ["completed", "refunded", "reversed"].includes(result.status) &&
          !result.synced
        )
          return new Response(null, { status: 503 });
      }
    }
    // Events without related order IDs are covered by scheduled reconciliation.
    return new Response(null, { status: 204 });
  } catch {
    console.error(JSON.stringify({ event: "paypal_webhook_failed" }));
    return new Response(null, { status: 400 });
  }
}
