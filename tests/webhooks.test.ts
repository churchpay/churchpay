import assert from "node:assert/strict";
import { test } from "node:test";
import type { Tenant } from "../lib/config";
import { verifyWebhook } from "../lib/paypal";

const tenant: Tenant = {
  domain: "demo",
  churchToolsUrl: "https://demo.church.tools",
  churchToolsToken: "dummy",
  clientId: "dummy",
  clientSecret: "dummy",
  merchantId: "MERCHANT",
  environment: "sandbox",
  webhookId: "WEBHOOK",
};
const headers = new Headers({
  "paypal-auth-algo": "SHA256withRSA",
  "paypal-cert-url": "https://attacker.invalid/certificate",
  "paypal-transmission-id": "TRANSMISSION",
  "paypal-transmission-sig": "signature",
  "paypal-transmission-time": "2026-11-03T12:00:00Z",
});

test("missing signature headers are rejected without network requests", async () => {
  const original = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    throw new Error("unexpected request");
  };
  try {
    await assert.rejects(verifyWebhook(tenant, new Headers(), {}));
    assert.equal(called, false);
  } finally {
    globalThis.fetch = original;
  }
});

test("webhooks use PayPal verification and never fetch attacker supplied certificate URLs", async () => {
  const original = globalThis.fetch;
  const calls: string[] = [];
  let verificationStatus = "SUCCESS";
  globalThis.fetch = async (url, options) => {
    calls.push(String(url));
    assert.equal(options?.redirect, "error");
    if (String(url).endsWith("/token"))
      return Response.json({ access_token: "DUMMY_TOKEN" });
    const body = JSON.parse(String(options?.body));
    assert.equal(body.webhook_id, tenant.webhookId);
    assert.equal(body.cert_url, headers.get("paypal-cert-url"));
    return Response.json({ verification_status: verificationStatus });
  };
  try {
    await verifyWebhook(tenant, headers, { id: "EVENT" });
    assert.deepEqual(calls, [
      "https://api-m.sandbox.paypal.com/v1/oauth2/token",
      "https://api-m.sandbox.paypal.com/v1/notifications/verify-webhook-signature",
    ]);
    verificationStatus = "FAILURE";
    await assert.rejects(verifyWebhook(tenant, headers, { id: "EVENT" }));
  } finally {
    globalThis.fetch = original;
  }
});
