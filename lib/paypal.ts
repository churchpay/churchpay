import {
  CheckoutPaymentIntent,
  Client,
  Environment,
  OrdersController,
  PaymentsController,
} from "@paypal/paypal-server-sdk";
import { z } from "zod";
import type { Tenant } from "./config";
import { formatPayPalAmount } from "./money";
import type { Payment } from "./payment-store";
import type { Quote } from "./types";

export function paymentDescription(
  payment: Pick<Payment, "groupId" | "personId">,
  quote: Pick<Quote, "groupName" | "personName">,
) {
  const prefix = `Anmeldung von ${quote.personName} (Person #${payment.personId}) zu `;
  const suffix = ` (#${payment.groupId})`;
  const available = 127 - Array.from(prefix + suffix).length;
  if (available < 0)
    throw new Error(
      "Participant name and IDs exceed PayPal's description limit",
    );
  return (
    prefix + Array.from(quote.groupName).slice(0, available).join("") + suffix
  );
}

const amountSchema = z.object({
  currencyCode: z.string(),
  value: z.string().regex(/^[0-9]+\.[0-9]{2}$/),
});
const captureSchema = z.object({
  id: z.string().min(1),
  status: z.string(),
  amount: amountSchema,
  finalCapture: z.boolean(),
});
const orderSchema = z.object({
  id: z.string().min(1),
  status: z.string(),
  intent: z.literal("CAPTURE"),
  purchaseUnits: z
    .array(
      z.object({
        customId: z.string(),
        invoiceId: z.string(),
        amount: amountSchema,
        payee: z.object({ merchantId: z.string() }),
        payments: z
          .object({
            captures: z.array(z.object({ id: z.string() })).optional(),
          })
          .optional(),
      }),
    )
    .length(1),
});
export type PayPalOrder = z.infer<typeof orderSchema>;
export type PayPalCapture = z.infer<typeof captureSchema>;
export interface PayPalGateway {
  create(payment: Payment, quote: Quote): Promise<string>;
  read(orderId: string): Promise<PayPalOrder>;
  capture(orderId: string, requestId: string): Promise<void>;
  readCapture(captureId: string): Promise<PayPalCapture>;
}

export function getPayPalClient(tenant: Tenant) {
  return new Client({
    clientCredentialsAuthCredentials: {
      oAuthClientId: tenant.clientId,
      oAuthClientSecret: tenant.clientSecret,
    },
    environment:
      tenant.environment === "live"
        ? Environment.Production
        : Environment.Sandbox,
    timeout: 15000,
  });
}

export function paypalGateway(tenant: Tenant): PayPalGateway {
  const client = getPayPalClient(tenant);
  const orders = new OrdersController(client);
  const payments = new PaymentsController(client);
  return {
    async create(payment, quote) {
      const response = await orders.createOrder({
        paypalRequestId: `${payment.id}-create`,
        prefer: "return=representation",
        body: {
          intent: CheckoutPaymentIntent.Capture,
          purchaseUnits: [
            {
              amount: {
                currencyCode: "EUR",
                value: formatPayPalAmount(payment.amountCents),
              },
              payee: { merchantId: tenant.merchantId },
              description: paymentDescription(payment, quote),
              customId: payment.id,
              invoiceId: `churchpay-${payment.id}`,
            },
          ],
        },
      });
      return z
        .string()
        .regex(/^[A-Z0-9]{1,36}$/)
        .parse(response.result.id);
    },
    async read(orderId) {
      return orderSchema.parse((await orders.getOrder({ id: orderId })).result);
    },
    async capture(orderId, requestId) {
      await orders.captureOrder({
        id: orderId,
        paypalRequestId: requestId,
        prefer: "return=representation",
      });
    },
    async readCapture(captureId) {
      return captureSchema.parse(
        (await payments.getCapturedPayment({ captureId })).result,
      );
    },
  };
}

async function paypalPost(
  tenant: Tenant,
  path: string,
  body: unknown,
  token: string,
) {
  const base =
    tenant.environment === "live"
      ? "https://api-m.paypal.com"
      : "https://api-m.sandbox.paypal.com";
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
    redirect: "error",
    cache: "no-store",
  });
  if (!response.ok) throw new Error("PayPal webhook verification failed");
  return response.json() as Promise<unknown>;
}

export async function verifyWebhook(
  tenant: Tenant,
  headers: Headers,
  event: unknown,
) {
  const value = (name: string) =>
    z.string().min(1).max(4096).parse(headers.get(name));
  const verification = {
    auth_algo: value("paypal-auth-algo"),
    cert_url: value("paypal-cert-url"),
    transmission_id: value("paypal-transmission-id"),
    transmission_sig: value("paypal-transmission-sig"),
    transmission_time: value("paypal-transmission-time"),
    webhook_id: tenant.webhookId,
    webhook_event: event,
  };
  const base =
    tenant.environment === "live"
      ? "https://api-m.paypal.com"
      : "https://api-m.sandbox.paypal.com";
  const response = await fetch(`${base}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${tenant.clientId}:${tenant.clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
    signal: AbortSignal.timeout(15000),
    redirect: "error",
    cache: "no-store",
  });
  if (!response.ok) throw new Error("PayPal authentication failed");
  const token = z
    .object({ access_token: z.string().min(1) })
    .parse(await response.json()).access_token;
  const result = await paypalPost(
    tenant,
    "/v1/notifications/verify-webhook-signature",
    verification,
    token,
  );
  if (
    z.object({ verification_status: z.string() }).parse(result)
      .verification_status !== "SUCCESS"
  )
    throw new Error("Invalid PayPal webhook signature");
}
