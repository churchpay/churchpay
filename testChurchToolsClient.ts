import { getChurchToolsClient } from "./lib/churchtools";
import * as dotenv from "dotenv";

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1) {
    console.error("Usage: npm run test-churchtools-client -- <domain>");
    process.exit(1);
  }
  dotenv.config();
  const domain = args[0];
  const client = getChurchToolsClient(domain);

  if (!client) {
    console.error("Invalid token or domain.");
    process.exit(1);
  }

  try {
    const groups = await client.getAllPages("/groups");
    console.log("Visible groups:", groups);
  } catch (error) {
    console.error("Error fetching groups:", error);
  }
}

main();
