import "dotenv/config";
import { migrateDatabase } from "../lib/migrations";
import { database } from "../lib/payment-store";

async function main() {
  await migrateDatabase(database());
  console.log("ChurchPay database migration complete.");
}
main()
  .catch(() => {
    console.error(
      "Database migration failed. Check DATABASE_URL and database permissions.",
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    if (process.env.DATABASE_URL) await database().end();
  });
