import { readFile, readdir } from "node:fs/promises";
import type { Pool } from "pg";

export async function migrateDatabase(db: Pick<Pool, "query">) {
  const files = (await readdir("migrations"))
    .filter((file) => /^\d+_[a-z_]+\.sql$/.test(file))
    .sort();
  for (const file of files)
    await db.query(await readFile(`migrations/${file}`, "utf8"));
}
