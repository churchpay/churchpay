import paypal from "@paypal/checkout-server-sdk";
import { getPayPalClient } from "./lib/paypal";
import * as dotenv from "dotenv";

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1) {
    console.error("Usage: npm run test-paypal-client -- <domain>");
    process.exit(1);
  }
  dotenv.config();
  const domain = args[0];
  const client = getPayPalClient(domain, false);

  try {
    const request = new paypal.orders.OrdersGetRequest("ORDER_ID");
    const response = await client!.execute(request);
    console.log("PayPal client is valid:", response);
  } catch (error: any) {
    // RESOURCE_NOT_FOUND is intentional since ORDER_ID is invalid
    if (error.message.includes("RESOURCE_NOT_FOUND")) {
      console.log("PayPal client is valid.");
    } else {
      console.error("Error validating PayPal client:", error.message);
    }
  }
}

main();
