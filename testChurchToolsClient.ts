import "dotenv/config";
import { getChurchToolsClient } from "./lib/churchtools";

async function main() {
  const [domain, ...extra] = process.argv.slice(2);
  if (!domain || extra.length) throw new Error("Invalid arguments");
  await getChurchToolsClient(domain).get("/whoami");
  console.log("ChurchTools credentials are valid.");
}
main().catch(() => {
  console.error(
    "ChurchTools connection failed. Usage: npm run test-churchtools-client -- <configured-domain>",
  );
  process.exitCode = 1;
});
