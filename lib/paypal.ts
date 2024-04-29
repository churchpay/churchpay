import checkoutNodeJssdk from "@paypal/checkout-server-sdk";
import { getEnvForDomain } from "./domainenv";

export function getPayPalClient(domain: string) {
  const clientId = getEnvForDomain("PAYPAL_CLIENT_ID", domain);
  const clientSecret = getEnvForDomain("PAYPAL_CLIENT_SECRET", domain);
  const useSandbox =
    process.env.NODE_ENV !== "production" ||
    getEnvForDomain("USE_SANDBOX", domain) == "1";

  if (!clientId || !clientSecret) {
    return null;
  }

  const environment = useSandbox
    ? new checkoutNodeJssdk.core.SandboxEnvironment(clientId, clientSecret)
    : new checkoutNodeJssdk.core.LiveEnvironment(clientId, clientSecret);

  return new checkoutNodeJssdk.core.PayPalHttpClient(environment);
}
