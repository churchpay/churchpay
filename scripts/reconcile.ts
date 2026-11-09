import "dotenv/config";
import { validateConfiguration } from "../lib/config";
import { database } from "../lib/payment-store";
import { reconcilePayments } from "../lib/reconcile";

async function main() {
  validateConfiguration();
  const result = await reconcilePayments();
  console.log(JSON.stringify(result));
  if (result.failures || result.review) process.exitCode = 1;
}
main()
  .catch(() => {
    console.error(
      "Payment reconciliation failed. Check configuration and service availability.",
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    if (process.env.DATABASE_URL) await database().end();
  });
