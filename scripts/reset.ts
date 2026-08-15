import { closeDriver, runAutocommit } from "@/lib/db/driver";
import { DELETE_ALL_BATCHED, DELETE_ALL_SIMPLE } from "@/lib/db/schema";
import { getEnv } from "@/lib/env";
import { fail, heading, ok, reportFatal, step, style, warn } from "./cli";

/**
 * Deletes every node and relationship.
 *
 *   npm run db:reset -- --yes
 *
 * The `--yes` flag is required. This is the only destructive script in the
 * repository, and it is one typo away from wiping a production instance - the
 * connection string it uses is whatever `.env.local` currently points at, which
 * during a deploy is the live database. Making the destructive path explicit is
 * cheaper than restoring from a backup that the free tier does not have.
 *
 * Schema (constraints and indexes) is left intact; only data is removed.
 */
async function main(): Promise<void> {
  const env = getEnv();

  heading("Understory | reset");

  if (!process.argv.includes("--yes")) {
    warn(`This deletes ALL data in ${style.bold(env.displayHost)} (database: ${env.neo4jDatabase}).`);
    process.stdout.write(
      `\n  Re-run with the confirmation flag if that is what you intend:\n\n` +
        `    ${style.cyan("npm run db:reset -- --yes")}\n\n`,
    );
    process.exitCode = 1;
    return;
  }

  step(`Deleting all data from ${env.displayHost}...`);

  try {
    await runAutocommit(DELETE_ALL_BATCHED, "delete-all-batched");
  } catch (error) {
    // `CALL { ... } IN TRANSACTIONS` is not universally supported. Fall back to a
    // single-transaction delete, which is fine for a graph this size.
    const message = error instanceof Error ? error.message : String(error);
    warn(`Batched delete unavailable (${message.split("\n")[0]}); falling back.`);
    await runAutocommit(DELETE_ALL_SIMPLE, "delete-all-simple");
  }

  ok("Graph emptied. Run `npm run db:seed` to repopulate.");
  process.stdout.write("\n");
}

main()
  .catch((error: unknown) => reportFatal("Reset failed", error))
  .finally(() => closeDriver());
