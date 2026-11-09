"use server";

import { z } from "zod";
import { getTenant, referenceSchema } from "./config";
import { rateLimit, referenceKey } from "./payment-store";
import { paymentService } from "./payments";
import type { PaymentInfo } from "./types";

const error = {
  type: "error" as const,
  message:
    "Die Zahlungsinformationen konnten nicht geladen werden. Bitte prüfe deinen Link oder versuche es später erneut. Bei einer bereits bestätigten Zahlung wird der Status automatisch abgeglichen.",
};

async function validateRequest(
  input: unknown,
  operation: string,
  limit: number,
) {
  const access = referenceSchema.parse(input);
  getTenant(access.domain);
  await rateLimit(`${referenceKey(access)}:${operation}`, limit);
  return access;
}

export async function getPaymentInfo(input: unknown): Promise<PaymentInfo> {
  try {
    const access = await validateRequest(input, "info", 60);
    return await paymentService(access.domain).info(access);
  } catch {
    console.error(JSON.stringify({ event: "payment_info_failed" }));
    return error;
  }
}

export async function createPayPalPayment(input: unknown) {
  try {
    const access = await validateRequest(input, "create", 10);
    return await paymentService(access.domain).create(access);
  } catch {
    console.error(JSON.stringify({ event: "payment_create_failed" }));
    return error;
  }
}

export async function capturePayPalPayment(input: unknown, orderId: unknown) {
  try {
    const access = await validateRequest(input, "capture", 30);
    const id = z
      .string()
      .regex(/^[A-Z0-9]{1,36}$/)
      .parse(orderId);
    return await paymentService(access.domain).capture(access, id);
  } catch {
    console.error(JSON.stringify({ event: "payment_capture_failed" }));
    return error;
  }
}
