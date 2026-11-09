import "dotenv/config";
import { getTenant } from "./lib/config";

async function main() {
  const [domain, ...extra] = process.argv.slice(2);
  if (!domain || extra.length) throw new Error("Invalid arguments");
  const tenant = getTenant(domain);
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
  });
  if (!response.ok) throw new Error("Invalid credentials");
  console.log(`PayPal credentials are valid (${tenant.environment}).`);
}
main().catch(() => {
  console.error(
    "PayPal connection failed. Usage: npm run test-paypal-client -- <configured-domain>",
  );
  process.exitCode = 1;
});
