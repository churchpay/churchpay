import { timingSafeEqual } from "node:crypto";
import { reconcilePayments } from "@/lib/reconcile";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  const actual = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  if (
    !secret ||
    secret.length < 32 ||
    actual.length !== expected.length ||
    !timingSafeEqual(actual, expected)
  )
    return new Response(null, { status: 401 });
  try {
    const result = await reconcilePayments();
    return Response.json(result, {
      status: result.failures || result.review ? 503 : 200,
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    console.error(JSON.stringify({ event: "reconciliation_failed" }));
    return new Response(null, { status: 503 });
  }
}
