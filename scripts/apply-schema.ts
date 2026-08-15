import { closeDriver, runAutocommit } from "@/lib/db/driver";
import { CONSTRAINTS, INDEXES } from "@/lib/db/schema";
import { ok, reportFatal, step, warn } from "./cli";

/**
 * Applies constraints and indexes.
 *
 *   npm run db:schema
 *
 * Also called as the first phase of `npm run db:seed`, hence the exported
 * function — the schema must exist before the loader's `MERGE`s run, or they
 * will create duplicates instead of matching.
 *
 * Constraints are fatal on failure; indexes are not. See `src/lib/db/schema.ts`
 * for why that asymmetry is deliberate.
 */
export async function applySchema({ quiet = false } = {}): Promise<void> {
  for (const constraint of CONSTRAINTS) {
    await runAutocommit(constraint.statement, constraint.name);
    if (!quiet) ok(`constraint ${constraint.name} — ${constraint.purpose}`);
  }

  for (const index of INDEXES) {
    try {
      await runAutocommit(index.statement, index.name);
      if (!quiet) ok(`index ${index.name} — ${index.purpose}`);
    } catch (error) {
      // Index *types* are the most vendor-specific part of openCypher. A server
      // that does not support TEXT indexes is still perfectly usable here; the
      // affected queries just fall back to a scan over a few thousand nodes.
      const message = error instanceof Error ? error.message : String(error);
      warn(`index ${index.name} not created (${message.split("\n")[0]}) — continuing`);
    }
  }
}

// Only run as a script when invoked directly, not when imported by the seeder.
const invokedDirectly = process.argv[1]?.replace(/\\/g, "/").endsWith("apply-schema.ts") === true;

if (invokedDirectly) {
  step("Applying schema…");
  applySchema()
    .then(() => ok("Schema up to date."))
    .catch((error: unknown) => reportFatal("Could not apply the schema", error))
    .finally(() => closeDriver());
}
